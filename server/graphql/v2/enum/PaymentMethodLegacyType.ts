import { GraphQLEnumType } from 'graphql';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import logger from '../../../lib/logger';
import { PaymentMethod } from '../../../types/PaymentMethod';

export enum PaymentMethodLegacyTypeEnum {
  CREDIT_CARD = 'CREDIT_CARD',
  GIFT_CARD = 'GIFT_CARD',
  PREPAID_BUDGET = 'PREPAID_BUDGET',
  ACCOUNT_BALANCE = 'ACCOUNT_BALANCE',
  PAYPAL = 'PAYPAL',
  BRAINTREE_PAYPAL = 'BRAINTREE_PAYPAL',
  BANK_TRANSFER = 'BANK_TRANSFER',
  ADDED_FUNDS = 'ADDED_FUNDS',
}

export const PaymentMethodLegacyType = new GraphQLEnumType({
  name: 'PaymentMethodLegacyType',
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore `deprecationReason` is not yet exposed by graphql but it does exist
  deprecationReason: '2021-03-02: Please use service + type',
  values: Object.keys(PaymentMethodLegacyTypeEnum).reduce((values, key) => {
    return { ...values, [key]: {} };
  }, {}),
});

export const getLegacyPaymentMethodType = ({ service, type }: PaymentMethod): PaymentMethodLegacyTypeEnum => {
  if (service === PAYMENT_METHOD_SERVICE.STRIPE) {
    if (type === PAYMENT_METHOD_TYPE.CREDITCARD) {
      return PaymentMethodLegacyTypeEnum.CREDIT_CARD;
    }
  } else if (service === PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE) {
    if (type === PAYMENT_METHOD_TYPE.GIFT_CARD) {
      return PaymentMethodLegacyTypeEnum.GIFT_CARD;
    } else if (type === PAYMENT_METHOD_TYPE.HOST) {
      return PaymentMethodLegacyTypeEnum.ADDED_FUNDS;
    } else if (type === PAYMENT_METHOD_TYPE.COLLECTIVE) {
      return PaymentMethodLegacyTypeEnum.ACCOUNT_BALANCE;
    } else if (type === PAYMENT_METHOD_TYPE.PREPAID) {
      return PaymentMethodLegacyTypeEnum.PREPAID_BUDGET;
    }
  } else if (service === PAYMENT_METHOD_SERVICE.BRAINTREE && type === PAYMENT_METHOD_TYPE.PAYPAL) {
    return PaymentMethodLegacyTypeEnum.BRAINTREE_PAYPAL;
  } else if (service === PAYMENT_METHOD_SERVICE.PAYPAL && type === PAYMENT_METHOD_TYPE.PAYMENT) {
    return PaymentMethodLegacyTypeEnum.PAYPAL;
  }

  logger.warn(`getPaymentMethodType: Unknown PM type for ${service}/${type}`);
};

type ServiceTypePair = { service: PAYMENT_METHOD_SERVICE; type: PAYMENT_METHOD_TYPE };

export const getServiceTypeFromLegacyPaymentMethodType = (type: PaymentMethodLegacyTypeEnum): ServiceTypePair => {
  switch (type) {
    case PaymentMethodLegacyTypeEnum.CREDIT_CARD:
      return { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.CREDITCARD };
    case PaymentMethodLegacyTypeEnum.GIFT_CARD:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.GIFT_CARD };
    case PaymentMethodLegacyTypeEnum.PREPAID_BUDGET:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.PREPAID };
    case PaymentMethodLegacyTypeEnum.ACCOUNT_BALANCE:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.COLLECTIVE };
    case PaymentMethodLegacyTypeEnum.ADDED_FUNDS:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.HOST };
    case PaymentMethodLegacyTypeEnum.BANK_TRANSFER:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.MANUAL };
    case PaymentMethodLegacyTypeEnum.PAYPAL:
      return { service: PAYMENT_METHOD_SERVICE.PAYPAL, type: PAYMENT_METHOD_TYPE.PAYMENT };
    case PaymentMethodLegacyTypeEnum.BRAINTREE_PAYPAL:
      return { service: PAYMENT_METHOD_SERVICE.BRAINTREE, type: PAYMENT_METHOD_TYPE.PAYPAL };
  }
};
