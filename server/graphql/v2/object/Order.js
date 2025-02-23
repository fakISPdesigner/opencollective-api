import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import roles from '../../../constants/roles';
import models from '../../../models';
import { ContributionFrequency, OrderStatus } from '../enum';
import { idEncode } from '../identifiers';
import { Account } from '../interface/Account';
import { Transaction } from '../interface/Transaction';
import { Amount } from '../object/Amount';
import { PaymentMethod } from '../object/PaymentMethod';
import { Tier } from '../object/Tier';

import { MemberOf } from './Member';
import OrderPermissions from './OrderPermissions';
import { OrderTax } from './OrderTax';

export const Order = new GraphQLObjectType({
  name: 'Order',
  description: 'Order model',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve(order) {
          return idEncode(order.id, 'order');
        },
      },
      legacyId: {
        type: new GraphQLNonNull(GraphQLInt),
        resolve(order) {
          return order.id;
        },
      },
      description: {
        type: GraphQLString,
        resolve(order) {
          return order.description;
        },
      },
      amount: {
        type: new GraphQLNonNull(Amount),
        resolve(order) {
          return { value: order.totalAmount, currency: order.currency };
        },
      },
      quantity: {
        type: GraphQLInt,
      },
      status: {
        type: OrderStatus,
        resolve(order) {
          return order.status;
        },
      },
      frequency: {
        type: ContributionFrequency,
        async resolve(order, _, req) {
          const subscription = order.SubscriptionId && (await req.loaders.Subscription.byId.load(order.SubscriptionId));
          if (!subscription) {
            return 'ONETIME';
          }
          if (subscription.interval === 'month') {
            return 'MONTHLY';
          } else if (subscription.interval === 'year') {
            return 'YEARLY';
          }
        },
      },
      nextChargeDate: {
        type: GraphQLDateTime,
        async resolve(order, _, req) {
          const subscription = order.SubscriptionId && (await req.loaders.Subscription.byId.load(order.SubscriptionId));
          return subscription?.nextChargeDate;
        },
      },
      tier: {
        type: Tier,
        resolve(order, args, req) {
          if (order.tier) {
            return order.tier;
          }
          if (order.TierId) {
            return req.loaders.Tier.byId.load(order.TierId);
          }
        },
      },
      fromAccount: {
        type: Account,
        resolve(order, _, req) {
          return req.loaders.Collective.byId.load(order.FromCollectiveId);
        },
      },
      toAccount: {
        type: Account,
        resolve(order, _, req) {
          return req.loaders.Collective.byId.load(order.CollectiveId);
        },
      },
      transactions: {
        description: 'Transactions for this order ordered by createdAt ASC',
        type: new GraphQLNonNull(new GraphQLList(Transaction)),
        resolve(order, _, req) {
          return req.loaders.Transaction.byOrderId.load(order.id);
        },
      },
      createdAt: {
        type: GraphQLDateTime,
        resolve(order) {
          return order.createdAt;
        },
      },
      updatedAt: {
        type: GraphQLDateTime,
        resolve(order) {
          return order.updatedAt;
        },
      },
      totalDonations: {
        type: new GraphQLNonNull(Amount),
        description:
          'WARNING: Total amount donated between collectives, though there will be edge cases especially when looking on the Order level, as the order id is not used in calculating this.',
        async resolve(order, args, req) {
          const value = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
            FromCollectiveId: order.FromCollectiveId,
            CollectiveId: order.CollectiveId,
          });
          return { value, currency: order.currency };
        },
      },
      paymentMethod: {
        type: PaymentMethod,
        resolve(order, _, req) {
          if (order.PaymentMethodId) {
            return req.loaders.PaymentMethod.byId.load(order.PaymentMethodId);
          }
        },
      },
      platformFee: {
        type: Amount,
        deprecationReason: '2020-07-31: Please use platformContributionAmount',
        resolve(order) {
          if (order.data?.isFeesOnTop) {
            return { value: order.data.platformFee };
          } else {
            return null;
          }
        },
      },
      platformContributionAmount: {
        type: Amount,
        description: 'Platform contribution attached to the Order.',
        resolve(order) {
          if (order.data?.isFeesOnTop) {
            return { value: order.data.platformFee, currency: order.currency };
          } else {
            return null;
          }
        },
      },
      taxes: {
        type: new GraphQLNonNull(new GraphQLList(OrderTax)),
        resolve(order) {
          if (order.data?.tax) {
            return [
              {
                type: order.data.tax.id,
                percentage: order.data.tax.percentage,
              },
            ];
          } else {
            return [];
          }
        },
      },
      membership: {
        type: MemberOf,
        description:
          'This represents a MemberOf relationship (ie: Collective backed by an Individual) attached to the Order.',
        async resolve(order) {
          return models.Member.findOne({
            where: {
              MemberCollectiveId: order.FromCollectiveId,
              CollectiveId: order.CollectiveId,
              role: roles.BACKER,
              TierId: order.TierId,
            },
          });
        },
      },
      permissions: {
        type: new GraphQLNonNull(OrderPermissions),
        description: 'The permissions given to current logged in user for this order',
        async resolve(order) {
          return order; // Individual fields are set by OrderPermissions resolvers
        },
      },
    };
  },
});
