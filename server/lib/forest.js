import path from 'path';

import Liana from 'forest-express-sequelize';

import models, { connections, objectMapping, Op } from '../models';

export async function init() {
  return Liana.init({
    configDir: path.resolve(__dirname, '../forest'),
    envSecret: process.env.FOREST_ENV_SECRET,
    authSecret: process.env.FOREST_AUTH_SECRET,
    objectMapping,
    connections,
  });
}

export default async function (app) {
  if (!process.env.FOREST_ENV_SECRET || !process.env.FOREST_AUTH_SECRET) {
    return;
  }

  const forestMiddleware = await init();

  app.use(forestMiddleware);

  app.post('/forest/actions/activate-subscription', Liana.ensureAuthenticated, (req, res) => {
    const data = req.body.data;
    const id = data.attributes.ids[0];
    models.Subscription.findOne({ where: { id } })
      .then(subscription => subscription.activate())
      .then(() => {
        res.status(200).send({ success: 'The subscription was successfully activated.' });
      })
      .catch(e => {
        res.status(400).send({ error: e.message });
      });
  });

  app.post('/forest/actions/cancel-subscription', Liana.ensureAuthenticated, (req, res) => {
    const data = req.body.data;
    const id = data.attributes.ids[0];
    models.Subscription.findOne({ where: { id } })
      .then(subscription => subscription.deactivate())
      .then(() => {
        res.status(200).send({ success: 'The subscription was successfully canceled.' });
      })
      .catch(e => {
        res.status(400).send({ error: e.message });
      });
  });

  app.post('/forest/actions/delete-collective-and-dependencies', Liana.ensureAuthenticated, async (req, res) => {
    const data = req.body.data;
    const id = data.attributes.ids[0];
    models.Collective.findOne({ where: { id } })
      .then(async collective => {
        // Check if we can delete the collective
        await models.Transaction.count({
          where: {
            [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }],
          },
        }).then(count => {
          if (count > 0) {
            throw Error('Can not delete user with existing orders.');
          }
        });
        await models.Order.count({
          where: {
            [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }],
          },
        }).then(count => {
          if (count > 0) {
            throw Error('Can not delete collective with existing orders.');
          }
        });
        await models.Expense.count({
          where: { CollectiveId: collective.id, status: 'PAID' },
        }).then(count => {
          if (count > 0) {
            throw Error('Can not delete collective with paid expenses.');
          }
        });
        // Delete Members
        await models.Member.findAll({
          where: { CollectiveId: collective.id },
        }).then(members => {
          members.forEach(async member => {
            await member.destroy();
          });
        });
        // Delete Expenses
        await models.Expense.findAll({
          where: { CollectiveId: collective.id },
        }).then(expenses => {
          expenses.forEach(async expense => {
            await expense.destroy();
          });
        });

        // Delete Tiers
        await models.Tier.findAll({
          where: { CollectiveId: collective.id },
        }).then(tiers => {
          tiers.forEach(async tier => {
            await tier.destroy();
          });
        });
        // Delete Payment Methods
        await models.PaymentMethod.findAll({
          where: { CollectiveId: collective.id },
        }).then(paymentMethods => {
          paymentMethods.forEach(async paymentMethod => {
            await paymentMethod.destroy();
          });
        });
        // Delete Collective
        await collective.destroy();
      })
      .then(() => {
        const msg = 'The collective and its dependencies were successfully deleted.';
        res.status(200).send({
          html: `<p>${msg}</p>
                 <p><a href="../../../">Click here to continue</a>.</p>`,
        });
      })
      .catch(e => {
        const msg = e.message;
        res.status(400).send({
          error: `There was an error while processing your request.\n
            "${msg}"\n
            Maybe you want to proceed manually?`,
        });
      });
  });

  app.post('/forest/actions/delete-user-and-dependencies', Liana.ensureAuthenticated, async (req, res) => {
    const data = req.body.data;
    const id = data.attributes.ids[0];
    try {
      const user = await models.User.findOne({ where: { id } });
      const userCollective = await models.Collective.findOne({
        where: { id: user.CollectiveId },
      });
      // Check if we can delete the user
      await models.Transaction.count({
        where: { FromCollectiveId: userCollective.id },
      }).then(count => {
        if (count > 0) {
          throw Error('Can not delete user with existing orders.');
        }
      });
      await models.Order.count({
        where: { FromCollectiveId: userCollective.id },
      }).then(count => {
        if (count > 0) {
          throw Error('Can not delete user with existing orders.');
        }
      });
      await models.Expense.count({
        where: { UserId: user.id, status: 'PAID' },
      }).then(count => {
        if (count > 0) {
          throw Error('Can not delete user with paid expenses.');
        }
      });
      // Delete Memberships
      await models.Member.findAll({
        where: { MemberCollectiveId: userCollective.id },
      }).then(members => {
        members.forEach(async member => {
          await member.destroy();
        });
      });
      // Delete Expenses
      await models.Expense.findAll({ where: { UserId: user.id } }).then(expenses => {
        expenses.forEach(async expense => {
          await expense.destroy();
        });
      });
      // Delete Payment Methods
      await models.PaymentMethod.findAll({
        where: { CollectiveId: userCollective.id },
      }).then(paymentMethods => {
        paymentMethods.forEach(async paymentMethod => {
          await paymentMethod.destroy();
        });
      });
      // Delete User
      await user.destroy();
      // Delete User Collective
      await userCollective.destroy();

      const msg = 'The user and its dependencies were successfully deleted.';
      res.status(200).send({
        html: `<p>${msg}</p>
               <p><a href="../../../">Click here to continue</a>.</p>`,
      });
    } catch (e) {
      const msg = e.message;
      res.status(400).send({
        error: `There was an error while processing your request.\n
          "${msg}"\n
          Maybe you want to proceed manually?`,
      });
    }
  });

  app.post('/forest/actions/delete-user-and-merge', Liana.ensureAuthenticated, async (req, res) => {
    const data = req.body.data;
    const id = data.attributes.ids[0];
    const mergeIntoUserId = data.attributes.values['User ID'];
    try {
      const user = await models.User.findOne({ where: { id } });
      const userCollective = await models.Collective.findOne({
        where: { id: user.CollectiveId },
      });
      if (!user || !userCollective) {
        throw Error('Can not fetch origin user.');
      }
      const mergeIntoUser = await models.User.findOne({
        where: { id: mergeIntoUserId },
      });
      const mergeIntoUserCollective = await models.Collective.findOne({
        where: { id: mergeIntoUser.CollectiveId },
      });
      if (!mergeIntoUser || !mergeIntoUserCollective) {
        throw Error('Can not fetch destination user.');
      }
      // Check if we can delete the user
      await models.Transaction.count({
        where: { FromCollectiveId: userCollective.id },
      }).then(count => {
        if (count > 0) {
          throw Error('Can not delete user with existing orders.');
        }
      });
      await models.Order.count({
        where: { FromCollectiveId: userCollective.id },
      }).then(count => {
        if (count > 0) {
          throw Error('Can not delete user with existing orders.');
        }
      });
      await models.Expense.count({
        where: { UserId: user.id, status: 'PAID' },
      }).then(count => {
        if (count > 0) {
          throw Error('Can not delete user with paid expenses.');
        }
      });
      // Merge Memberships
      await models.Member.findAll({
        where: { MemberCollectiveId: userCollective.id },
      }).then(members => {
        members.forEach(async member => {
          await member.update({
            MemberCollectiveId: mergeIntoUserCollective.id,
          });
        });
      });
      // Merge Expenses
      await models.Expense.findAll({ where: { UserId: user.id } }).then(expenses => {
        expenses.forEach(async expense => {
          await expense.update({ UserId: mergeIntoUser.id });
        });
      });
      // Merge Payment Methods
      await models.PaymentMethod.findAll({
        where: { CollectiveId: userCollective.id },
      }).then(paymentMethods => {
        paymentMethods.forEach(async paymentMethod => {
          await paymentMethod.update({
            CollectiveId: mergeIntoUserCollective.id,
          });
        });
      });
      // // Delete User
      await user.destroy();
      // // Delete User Collective
      await userCollective.destroy();

      const msg = 'The user was successfully deleted and its dependencies merged.';
      res.status(200).send({
        html: `<p>${msg}</p>
               <p><a href="../../../">Click here to continue</a>.</p>`,
      });
    } catch (e) {
      const msg = e.message;
      res.status(400).send({
        error: `There was an error while processing your request.\n
          "${msg}"\n
          Maybe you want to proceed manually?`,
      });
    }
  });
}
