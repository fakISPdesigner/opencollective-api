import config from 'config';
import { get, isNumber, result } from 'lodash';

import * as constants from '../../constants/transactions';
import logger from '../../lib/logger';
import { createRefundTransaction, getHostFee, getPlatformFee } from '../../lib/payments';
import stripe, { extractFees } from '../../lib/stripe';
import models from '../../models';

const UNKNOWN_ERROR_MSG = 'Something went wrong with the payment, please contact support@opencollective.com.';

/**
 * Get or create a customer under the platform stripe account
 */
const getOrCreateCustomerOnPlatformAccount = async ({ paymentMethod, user, collective }) => {
  if (paymentMethod.customerId) {
    return stripe.customers.retrieve(paymentMethod.customerId);
  }

  const payload = { source: paymentMethod.token };
  if (user) {
    payload.email = user.email;
  }
  if (collective) {
    payload.description = `https://opencollective.com/${collective.slug}`;
  }

  const customer = await stripe.customers.create(payload);

  paymentMethod.customerId = customer.id;
  await paymentMethod.update({ customerId: customer.id });

  return customer;
};

/**
 * Get the customerId for the Stripe Account of the Host
 * Or create one using the Stripe token associated with the platform (paymentMethod.token)
 * and saves it under PaymentMethod.data[hostStripeAccount.username]
 * @param {*} hostStripeAccount
 */
const getOrCreateCustomerOnHostAccount = async (hostStripeAccount, { paymentMethod, user }) => {
  // Customers pre-migration will have their stripe user connected
  // to the platform stripe account, not to the host's stripe
  // account. Since payment methods had no name before that
  // migration, we're using it to test for pre-migration users;

  // Well, DISCARD what is written above, these customers are coming from the Host
  if (!paymentMethod.name) {
    const customer = await stripe.customers.retrieve(paymentMethod.customerId, {
      stripeAccount: hostStripeAccount.username,
    });

    if (customer) {
      logger.info(`Pre-migration customer found: ${paymentMethod.customerId}`);
      logger.info(JSON.stringify(customer));
      return customer;
    }

    logger.info(`Pre-migration customer not found: ${paymentMethod.customerId}`);
    return { id: paymentMethod.customerId };
  }

  const data = paymentMethod.data || {};
  data.customerIdForHost = data.customerIdForHost || {};
  if (data.customerIdForHost[hostStripeAccount.username]) {
    return stripe.customers.retrieve(data.customerIdForHost[hostStripeAccount.username], {
      stripeAccount: hostStripeAccount.username,
    });
  } else {
    const platformStripeCustomer = await getOrCreateCustomerOnPlatformAccount({
      paymentMethod,
      user,
    });

    let customer;

    // This is a special case where the account is the root account
    if (hostStripeAccount.username === config.stripe.accountId) {
      customer = platformStripeCustomer;
    }

    // This is the normal case where we create a customer on the host connected account
    if (!customer) {
      // More info about that
      // - Documentation: https://stripe.com/docs/connect/shared-customers
      // - API: https://stripe.com/docs/api/tokens/create_card
      const token = await stripe.tokens.create(
        { customer: platformStripeCustomer.id },
        { stripeAccount: hostStripeAccount.username },
      );

      customer = await stripe.customers.create(
        { source: token.id, email: user.email },
        { stripeAccount: hostStripeAccount.username },
      );
    }

    data.customerIdForHost[hostStripeAccount.username] = customer.id;
    paymentMethod.data = data;
    await paymentMethod.update({ data });

    return customer;
  }
};

/**
 * Returns a Promise with the transaction created
 * Note: we need to create a token for hostStripeAccount because paymentMethod.customerId is a customer of the platform
 * See: Shared Customers: https://stripe.com/docs/connect/shared-customers
 */
const createChargeAndTransactions = async (hostStripeAccount, { order, hostStripeCustomer }) => {
  const host = await order.collective.getHostCollective();
  const hostPlan = await host.getPlan();
  const hostFeeSharePercent = isNumber(hostPlan?.creditCardHostFeeSharePercent)
    ? hostPlan?.creditCardHostFeeSharePercent
    : hostPlan?.hostFeeSharePercent;
  const isSharedRevenue = !!hostFeeSharePercent;

  // Read or compute Platform Fee
  const platformFee = await getPlatformFee(order.totalAmount, order, host, { hostFeeSharePercent });
  const platformTip = order.data?.platformFee;

  // Make sure data is available (breaking in some old tests)
  order.data = order.data || {};

  /* eslint-disable camelcase */

  let paymentIntent = order.data.paymentIntent;
  if (!paymentIntent) {
    const createPayload = {
      amount: order.totalAmount,
      currency: order.currency,
      customer: hostStripeCustomer.id,
      description: order.description,
      confirm: false,
      confirmation_method: 'manual',
      metadata: {
        from: `${config.host.website}/${order.fromCollective.slug}`,
        to: `${config.host.website}/${order.collective.slug}`,
      },
    };
    // We don't add a platform fee if the host is the root account
    if (platformFee && hostStripeAccount.username !== config.stripe.accountId) {
      createPayload.application_fee_amount = platformFee;
    }
    if (order.interval) {
      createPayload.setup_future_usage = 'off_session';
    } else if (!order.processedAt && order.data.savePaymentMethod) {
      createPayload.setup_future_usage = 'on_session';
    }
    // Add Payment Method ID if it's available
    const paymentMethodId = get(hostStripeCustomer, 'default_source', get(hostStripeCustomer, 'sources.data[0].id'));
    if (paymentMethodId) {
      createPayload.payment_method = paymentMethodId;
    } else {
      logger.info('paymentMethod is missing in hostStripeCustomer to pass to Payment Intent.');
      logger.info(JSON.stringify(hostStripeCustomer));
    }
    paymentIntent = await stripe.paymentIntents.create(createPayload, {
      stripeAccount: hostStripeAccount.username,
    });
  }

  paymentIntent = await stripe.paymentIntents.confirm(paymentIntent.id, {
    stripeAccount: hostStripeAccount.username,
  });

  /* eslint-enable camelcase */

  if (paymentIntent.next_action) {
    order.data.paymentIntent = { id: paymentIntent.id, status: paymentIntent.status };
    await order.update({ data: order.data });
    const paymentIntentError = new Error('Payment Intent require action');
    paymentIntentError.stripeAccount = hostStripeAccount.username;
    paymentIntentError.stripeResponse = { paymentIntent };
    throw paymentIntentError;
  }

  if (paymentIntent.status !== 'succeeded') {
    logger.error('Unknown error with Stripe Payment Intent.');
    logger.error(paymentIntent);
    throw new Error(UNKNOWN_ERROR_MSG);
  }

  const charge = paymentIntent.charges.data[0];

  const balanceTransaction = await stripe.balanceTransactions.retrieve(charge.balance_transaction, {
    stripeAccount: hostStripeAccount.username,
  });

  // Create a Transaction
  const fees = extractFees(balanceTransaction);
  const hostFeeInHostCurrency = await getHostFee(balanceTransaction.amount, order);
  const data = {
    charge,
    balanceTransaction,
    isFeesOnTop: order.data?.isFeesOnTop,
    isSharedRevenue,
    settled: true,
    platformFee: platformFee,
    platformTip,
    hostFeeSharePercent,
  };

  const platformFeeInHostCurrency = isSharedRevenue ? platformTip || 0 : fees.applicationFee;

  const payload = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    transaction: {
      type: constants.TransactionTypes.CREDIT,
      OrderId: order.id,
      amount: order.totalAmount,
      currency: order.currency,
      hostCurrency: balanceTransaction.currency?.toUpperCase(),
      amountInHostCurrency: balanceTransaction.amount,
      hostCurrencyFxRate: balanceTransaction.amount / order.totalAmount,
      paymentProcessorFeeInHostCurrency: fees.stripeFee,
      taxAmount: order.taxAmount,
      description: order.description,
      hostFeeInHostCurrency,
      platformFeeInHostCurrency,
      data,
    },
  };

  return models.Transaction.createFromPayload(payload);
};

/**
 * Given a charge id, retrieves its correspind charge and refund data.
 */
export const retrieveChargeWithRefund = async (chargeId, stripeAccount) => {
  const charge = await stripe.charges.retrieve(chargeId, {
    stripeAccount: stripeAccount.username,
  });
  if (!charge) {
    throw Error(`charge id ${chargeId} not found`);
  }
  const refundId = get(charge, 'refunds.data[0].id');
  const refund = await stripe.refunds.retrieve(refundId, {
    stripeAccount: stripeAccount.username,
  });
  return { charge, refund };
};

export const setupCreditCard = async (paymentMethod, { user, collective } = {}) => {
  const platformStripeCustomer = await getOrCreateCustomerOnPlatformAccount({
    paymentMethod,
    user,
    collective,
  });

  const paymentMethodId = platformStripeCustomer.sources.data[0].id;

  let setupIntent;
  if (paymentMethod.data.setupIntent) {
    setupIntent = await stripe.setupIntents.retrieve(paymentMethod.data.setupIntent.id);
    // TO CHECK: what happens if the setupIntent is not found
  }
  if (!setupIntent) {
    setupIntent = await stripe.setupIntents.create({
      customer: platformStripeCustomer.id,
      payment_method: paymentMethodId, // eslint-disable-line camelcase
      confirm: true,
    });
  }

  if (
    !paymentMethod.data.setupIntent ||
    paymentMethod.data.setupIntent.id !== setupIntent.id ||
    paymentMethod.data.setupIntent.status !== setupIntent.status
  ) {
    paymentMethod.data.setupIntent = { id: setupIntent.id, status: setupIntent.status };
    await paymentMethod.update({ data: paymentMethod.data });
  }

  if (setupIntent.next_action) {
    const setupIntentError = new Error('Setup Intent require action');
    setupIntentError.stripeResponse = { setupIntent };
    throw setupIntentError;
  }

  return paymentMethod;
};

export default {
  features: {
    recurring: true,
    waitToCharge: false,
  },

  processOrder: async order => {
    const hostStripeAccount = await order.collective.getHostStripeAccount();

    const hostStripeCustomer = await getOrCreateCustomerOnHostAccount(hostStripeAccount, {
      paymentMethod: order.paymentMethod,
      user: order.createdByUser,
    });

    let transactions;
    try {
      transactions = await createChargeAndTransactions(hostStripeAccount, {
        order,
        hostStripeCustomer,
      });
    } catch (error) {
      // Here, we check strictly the error message
      const knownErrors = [
        'Your card has insufficient funds.',
        'Your card was declined.',
        'Your card does not support this type of purchase.',
        'Your card has expired.',
        "Your card's security code is incorrect.",
        'Your card number is incorrect.',
        'The zip code you supplied failed validation.',
        'Invalid amount.',
        'Payment Intent require action',
      ];

      if (knownErrors.includes(error.message)) {
        throw error;
      }

      // Here, we do a partial check and rewrite the error.
      const identifiedErrors = {
        // This object cannot be accessed right now because another API request or Stripe process is currently accessing it.
        // If you see this error intermittently, retry the request.
        // If you see this error frequently and are making multiple concurrent requests to a single object, make your requests serially or at a lower rate.
        'This object cannot be accessed right now because another API request or Stripe process is currently accessing it.':
          'Payment Processing error (API request).',
        // You cannot confirm this PaymentIntent because it's missing a payment method.
        // To confirm the PaymentIntent with cus_9cNHqpdWYOV4aH, specify a payment method attached to this customer along with the customer ID.
        "You cannot confirm this PaymentIntent because it's missing a payment method.":
          'Internal Payment error (invalid PaymentIntent)',
        // You have exceeded the maximum number of declines on this card in the last 24 hour period.
        // Please contact us via https://support.stripe.com/contact if you need further assistance.
        'You have exceeded the maximum number of declines on this card': 'Your card was declined.',
        // An error occurred while processing your card. Try again in a little bit.
        'An error occurred while processing your card.': 'Payment Processing error (API error).',
        // This account cannot currently make live charges.
        // If you are a customer trying to make a purchase, please contact the owner of this site.
        // Your transaction has not been processed.
        'This account cannot currently make live charges.': 'Payment Processing error (Host error).',
      };
      const errorKey = Object.keys(identifiedErrors).find(errorMessage => error.message.includes(errorMessage));
      if (errorKey) {
        throw new Error(identifiedErrors[errorKey]);
      }

      logger.error(`Unknown Stripe Payment Error: ${error.message}`);
      logger.error(error);
      logger.error(error.stack);

      throw new Error(UNKNOWN_ERROR_MSG);
    }

    await order.paymentMethod.update({ confirmedAt: new Date() });

    return transactions;
  },

  /** Refund a given transaction */
  refundTransaction: async (transaction, user) => {
    /* What's going to be refunded */
    const chargeId = result(transaction.data, 'charge.id');

    /* From which stripe account it's going to be refunded */
    const collective = await models.Collective.findByPk(
      transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
    );
    const hostStripeAccount = await collective.getHostStripeAccount();

    /* Refund both charge & application fee */
    const shouldRefundApplicationFee = transaction.platformFeeInHostCurrency > 0;
    const refund = await stripe.refunds.create(
      { charge: chargeId, refund_application_fee: shouldRefundApplicationFee }, // eslint-disable-line camelcase
      { stripeAccount: hostStripeAccount.username },
    );
    const charge = await stripe.charges.retrieve(chargeId, { stripeAccount: hostStripeAccount.username });
    const refundBalance = await stripe.balanceTransactions.retrieve(refund.balance_transaction, {
      stripeAccount: hostStripeAccount.username,
    });
    const fees = extractFees(refundBalance);

    /* Create negative transactions for the received transaction */
    return await createRefundTransaction(
      transaction,
      fees.stripeFee,
      {
        ...transaction.data,
        refund,
        balanceTransaction: refundBalance,
        charge,
      },
      user,
    );
  },

  /** Refund a given transaction that was already refunded
   * in stripe but not in our database
   */
  refundTransactionOnlyInDatabase: async (transaction, user) => {
    /* What's going to be refunded */
    const chargeId = result(transaction.data, 'charge.id');

    /* From which stripe account it's going to be refunded */
    const collective = await models.Collective.findByPk(
      transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
    );
    const hostStripeAccount = await collective.getHostStripeAccount();

    /* Refund both charge & application fee */
    const { charge, refund } = await retrieveChargeWithRefund(chargeId, hostStripeAccount);
    if (!refund) {
      throw new Error('No refunds found in stripe.');
    }
    const refundBalance = await stripe.balanceTransactions.retrieve(refund.balance_transaction, {
      stripeAccount: hostStripeAccount.username,
    });
    const fees = extractFees(refundBalance);

    /* Create negative transactions for the received transaction */
    return await createRefundTransaction(
      transaction,
      fees.stripeFee,
      { ...transaction.data, charge, refund, balanceTransaction: refundBalance },
      user,
    );
  },

  webhook: (/* requestBody, event */) => {
    // We don't do anything at the moment
    return Promise.resolve();
  },
};
