import { GraphQLFloat, GraphQLInt, GraphQLInterfaceType, GraphQLObjectType, GraphQLString } from 'graphql';
import { get } from 'lodash';

import models from '../../models';
import { idEncode } from '../v2/identifiers';

import { CollectiveInterfaceType, UserCollectiveType } from './CollectiveInterface';
import { DateString, ExpenseType, OrderType, PaymentMethodType, SubscriptionType, UserType } from './types';

export const TransactionInterfaceType = new GraphQLInterfaceType({
  name: 'Transaction',
  description: 'Transaction interface',
  resolveType: transaction => {
    switch (transaction.type) {
      case 'CREDIT':
        return TransactionOrderType;
      case 'DEBIT':
        return TransactionExpenseType;
      default:
        return null;
    }
  },
  fields: () => {
    return {
      id: { type: GraphQLInt },
      idV2: { type: GraphQLString },
      uuid: { type: GraphQLString },
      amount: { type: GraphQLInt },
      currency: { type: GraphQLString },
      hostCurrency: { type: GraphQLString },
      hostCurrencyFxRate: { type: GraphQLFloat },
      netAmountInCollectiveCurrency: { type: GraphQLInt },
      hostFeeInHostCurrency: { type: GraphQLInt },
      platformFeeInHostCurrency: { type: GraphQLInt },
      paymentProcessorFeeInHostCurrency: { type: GraphQLInt },
      taxAmount: { type: GraphQLInt },
      createdByUser: { type: UserType },
      host: { type: CollectiveInterfaceType },
      paymentMethod: { type: PaymentMethodType },
      fromCollective: { type: CollectiveInterfaceType },
      usingGiftCardFromCollective: { type: CollectiveInterfaceType },
      collective: { type: CollectiveInterfaceType },
      type: { type: GraphQLString },
      description: { type: GraphQLString },
      createdAt: { type: DateString },
      updatedAt: { type: DateString },
      refundTransaction: { type: TransactionInterfaceType },
    };
  },
});

const TransactionFields = () => {
  return {
    id: {
      type: GraphQLInt,
      resolve(transaction) {
        return transaction.id;
      },
    },
    idV2: {
      type: GraphQLString,
      resolve(transaction) {
        return idEncode(transaction.id, 'transaction');
      },
    },
    refundTransaction: {
      type: TransactionInterfaceType,
      resolve(transaction) {
        return transaction.getRefundTransaction();
      },
    },
    uuid: {
      type: GraphQLString,
      resolve(transaction, args, req) {
        if (!req.remoteUser) {
          return null;
        }
        // If it's a sequelize model transaction, it means it has the method getDetailsForUser
        // otherwise we return transaction.uuid
        if (transaction && transaction.getDetailsForUser) {
          return transaction.getDetailsForUser(req.remoteUser);
        }
        return transaction.uuid;
      },
    },
    type: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.type;
      },
    },
    amount: {
      type: GraphQLInt,
      resolve(transaction) {
        return transaction.amount;
      },
    },
    currency: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.currency;
      },
    },
    hostCurrency: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.hostCurrency;
      },
    },
    hostCurrencyFxRate: {
      type: GraphQLFloat,
      description:
        'Exchange rate between the currency of the transaction and the currency of the host (transaction.amount * transaction.hostCurrencyFxRate = transaction.amountInHostCurrency)',
      resolve(transaction) {
        return transaction.hostCurrencyFxRate;
      },
    },
    hostFeeInHostCurrency: {
      type: GraphQLInt,
      description: 'Fee kept by the host in the lowest unit of the currency of the host (ie. in cents)',
      resolve(transaction) {
        return transaction.hostFeeInHostCurrency;
      },
    },
    platformFeeInHostCurrency: {
      type: GraphQLInt,
      description:
        'Fee kept by the Open Collective Platform in the lowest unit of the currency of the host (ie. in cents)',
      resolve(transaction) {
        return transaction.platformFeeInHostCurrency;
      },
    },
    paymentProcessorFeeInHostCurrency: {
      type: GraphQLInt,
      description: 'Fee kept by the payment processor in the lowest unit of the currency of the host (ie. in cents)',
      resolve(transaction) {
        return transaction.paymentProcessorFeeInHostCurrency;
      },
    },
    taxAmount: {
      type: GraphQLInt,
      description: 'The amount paid in tax (for example VAT) for this transaction',
    },
    netAmountInCollectiveCurrency: {
      type: GraphQLInt,
      description: 'Amount after fees received by the collective in the lowest unit of its own currency (ie. cents)',
      resolve(transaction) {
        return transaction.netAmountInCollectiveCurrency;
      },
    },
    host: {
      type: UserCollectiveType,
      async resolve(transaction) {
        if (transaction && transaction.getHostCollective) {
          return transaction.getHostCollective();
        }
        const FromCollectiveId = transaction.fromCollective.id;
        const CollectiveId = transaction.collective.id;
        let HostCollectiveId = transaction.HostCollectiveId;
        // if the transaction is from the perspective of the fromCollective
        if (!HostCollectiveId) {
          const fromCollective = await models.Collective.findByPk(FromCollectiveId);
          HostCollectiveId = await fromCollective.getHostCollectiveId();
          // if fromCollective has no host, we try the collective
          if (!HostCollectiveId) {
            const collective = await models.Collective.findByPk(CollectiveId);
            HostCollectiveId = await collective.getHostCollectiveId();
          }
        }
        return models.Collective.findByPk(HostCollectiveId);
      },
    },
    createdByUser: {
      type: UserType,
      async resolve(transaction, args, req) {
        // We don't return the user if the transaction has been created by someone who wanted to remain incognito
        // This is very suboptimal. We should probably record the CreatedByCollectiveId (or better CreatedByProfileId) instead of the User.
        if (transaction && transaction.getCreatedByUser) {
          const collective = await transaction.getCollective();
          const fromCollective = await transaction.getFromCollective();
          if (fromCollective.isIncognito && (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective))) {
            return {};
          }
          if (collective.isIncognito && (!req.remoteUser || !req.remoteUser.isAdminOfCollective(fromCollective))) {
            return {};
          }
          return transaction.getCreatedByUser();
        }
        return null;
      },
    },
    fromCollective: {
      type: CollectiveInterfaceType,
      resolve(transaction) {
        // If it's a sequelize model transaction, it means it has the method getFromCollective
        // otherwise we check whether transaction has 'fromCollective.id', if not we return null
        if (transaction && transaction.getFromCollective) {
          return transaction.getFromCollective();
        }
        if (get(transaction, 'fromCollective.id')) {
          return models.Collective.findByPk(get(transaction, 'fromCollective.id'));
        }
        return null;
      },
    },
    usingGiftCardFromCollective: {
      type: CollectiveInterfaceType,
      resolve(transaction) {
        // If it's a sequelize model transaction, it means it has the method getGiftCardEmitterCollective
        // otherwise we find the collective by id if transactions has UsingGiftCardFromCollectiveId, if not we return null
        if (transaction && transaction.getGiftCardEmitterCollective) {
          return transaction.getGiftCardEmitterCollective();
        }
        if (transaction && transaction.UsingGiftCardFromCollectiveId) {
          return models.Collective.findByPk(transaction.UsingGiftCardFromCollectiveId);
        }
        return null;
      },
    },
    collective: {
      type: CollectiveInterfaceType,
      resolve(transaction) {
        // If it's a sequelize model transaction, it means it has the method getCollective
        // otherwise we check whether transaction has 'collective.id', if not we return null
        if (transaction && transaction.getCollective) {
          return transaction.getCollective();
        }
        if (get(transaction, 'collective.id')) {
          return models.Collective.findByPk(get(transaction, 'collective.id'));
        }
        return null;
      },
    },
    createdAt: {
      type: DateString,
      resolve(transaction) {
        return transaction.createdAt;
      },
    },
    updatedAt: {
      type: DateString,
      resolve(transaction) {
        return transaction.updatedAt;
      },
    },
    paymentMethod: {
      type: PaymentMethodType,
      resolve(transaction, args, req) {
        const paymentMethodId = transaction.PaymentMethodId || get(transaction, 'paymentMethod.id');
        if (!paymentMethodId) {
          return null;
        }
        // TODO: put behind a login check
        return req.loaders.PaymentMethod.byId.load(paymentMethodId);
      },
    },
  };
};
export const TransactionExpenseType = new GraphQLObjectType({
  name: 'Expense',
  description: 'Expense model',
  interfaces: [TransactionInterfaceType],
  fields: () => {
    return {
      ...TransactionFields(),
      description: {
        type: GraphQLString,
        resolve(transaction) {
          // If it's a sequelize model transaction, it means it has the method getExpense
          // otherwise we return transaction.description , if not then return null
          const expense = transaction.getExpense
            ? transaction.getExpense().then(expense => expense && expense.description)
            : null;
          return transaction.description || expense;
        },
      },
      expense: {
        type: ExpenseType,
        resolve(transaction, args, req) {
          // If it's a expense transaction it'll have an ExpenseId
          // otherwise we return null
          return transaction.ExpenseId ? req.loaders.Expense.byId.load(transaction.ExpenseId) : null;
        },
      },
    };
  },
});

export const TransactionOrderType = new GraphQLObjectType({
  name: 'Order',
  description: 'Order model',
  interfaces: [TransactionInterfaceType],
  fields: () => {
    return {
      ...TransactionFields(),
      description: {
        type: GraphQLString,
        async resolve(transaction, _, req) {
          if (transaction.description) {
            return transaction.description;
          } else {
            const order = await req.loaders.Order.byId.load(transaction.OrderId);
            return order?.description;
          }
        },
      },
      publicMessage: {
        type: GraphQLString,
        async resolve(transaction, _, req) {
          if (transaction.OrderId) {
            const order = await req.loaders.Order.byId.load(transaction.OrderId);
            return order?.publicMessage;
          }
        },
      },
      order: {
        type: OrderType,
        resolve(transaction, _, req) {
          if (transaction.OrderId) {
            return req.loaders.Order.byId.load(transaction.OrderId);
          }
        },
      },
      subscription: {
        type: SubscriptionType,
        async resolve(transaction, _, req) {
          if (transaction.OrderId) {
            const order = await req.loaders.Order.byId.load(transaction.OrderId);
            if (order?.SubscriptionId) {
              return req.loaders.Subscription.byId.load(order.SubscriptionId);
            }
          }
        },
      },
    };
  },
});
