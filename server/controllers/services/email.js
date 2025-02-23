import Promise from 'bluebird';
import config from 'config';
import debug from 'debug';
import { get, pick } from 'lodash';
import request from 'request-promise';

import emailLib from '../../lib/email';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import models, { Op, sequelize } from '../../models';

const debugEmail = debug('email');
const debugWebhook = debug('webhook');

export const unsubscribe = (req, res, next) => {
  const { type, email, slug, token } = req.params;

  if (!emailLib.isValidUnsubscribeToken(token, email, slug, type)) {
    return next(new errors.BadRequest('Invalid token'));
  }

  Promise.all([models.Collective.findOne({ where: { slug } }), models.User.findOne({ where: { email } })])
    .then(results => {
      if (!results[1]) {
        throw new errors.NotFound(`Cannot find a user with email "${email}"`);
      }

      return results[1].unsubscribe(results[0] && results[0].id, type, 'email');
    })
    .then(() => res.send({ response: 'ok' }))
    .catch(next);
};

// TODO: move to emailLib.js
const sendEmailToList = async (to, email) => {
  debugEmail('sendEmailToList', to, 'email data: ', email);

  const { mailinglist, collectiveSlug, type } = getNotificationType(to);
  email.from = email.from || `${collectiveSlug} collective <no-reply@${collectiveSlug}.opencollective.com>`;
  email.collective = email.collective || { slug: collectiveSlug }; // used for the unsubscribe url

  const subscribers = await models.Notification.getSubscribersUsers(collectiveSlug, mailinglist);
  if (subscribers.length === 0) {
    throw new errors.NotFound(`No subscribers found in ${collectiveSlug} for email type ${type}`);
  }

  const recipients = subscribers.map(r => r.email);

  debugEmail(`Sending email from ${email.from} to ${to} (${recipients.length} recipient(s))`);
  return Promise.map(recipients, recipient => {
    if (email.template) {
      return emailLib.send(email.template, to, email, {
        from: email.from,
        bcc: recipient,
        type,
      });
    } else {
      email.body += '\n<!-- OpenCollective.com -->\n'; // watermark to identify if email has already been processed
      return emailLib.sendMessage(to, email.subject, email.body, {
        from: email.from,
        bcc: recipient,
        type,
      });
    }
  });
};

/**
 * Only take the param from request if it's a two letter country code
 */
const getMailServer = req => {
  if (req.query.mailserver?.match(/^[a-z]{2}$/i)) {
    return req.query.mailserver;
  } else {
    return 'so';
  }
};

export const approve = (req, res, next) => {
  const { messageId } = req.query;
  const approverEmail = req.query.approver;
  const mailserver = getMailServer(req);

  if (!messageId) {
    return next(new errors.BadRequest('No messageId provided'));
  } else if (!messageId.match(/^\w+=*$/i)) {
    return next(new errors.BadRequest('Invalid messageId provided'));
  }

  let approver, sender;
  let email = {};

  const fetchSenderAndApprover = email => {
    sender = { name: email.From, email: email.sender }; // default value
    const where = {
      [Op.or]: [{ email: approverEmail }, { email: email.sender }],
    };
    return models.User.findAll({
      attributes: ['email', 'CollectiveId'],
      where,
      include: { model: models.Collective, as: 'collective' },
    })
      .then(users => {
        users.map(user => {
          if (approverEmail === user.email) {
            approver = pick(user.collective, ['name', 'image']);
            approver.email = user.email;
          }
          if (email.sender === user.email) {
            sender = pick(user.collective, ['name', 'image']);
            sender.email = user.email;
          }
        });
      })
      .catch(e => {
        logger.error(e);
      });
  };

  const requestOptions = {
    json: true,
    auth: {
      user: 'api',
      pass: get(config, 'mailgun.apiKey'),
    },
  };

  return request
    .get(`https://${mailserver}.api.mailgun.net/v3/domains/opencollective.com/messages/${messageId}`, requestOptions)
    .then(json => {
      email = json;
      return email;
    })
    .then(fetchSenderAndApprover)
    .then(() => {
      const emailData = {
        template: 'email.message',
        subject: email.Subject,
        body: email['body-html'] || email['body-plain'],
        to: email.To,
        sender: pick(sender, ['email', 'name', 'image']),
      };
      if (approver && approver.email !== sender.email) {
        emailData.approver = pick(approver, ['email', 'name', 'image']);
      }

      return sendEmailToList(email.To, emailData);
    })
    .then(() =>
      res.send(`Email from ${email.sender} with subject "${email.Subject}" approved for the ${email.To} mailing list`),
    )
    .catch(e => {
      if (e.statusCode === 404) {
        return next(new errors.NotFound(`Message ${messageId} not found on the ${mailserver} server`));
      } else {
        logger.error(e);
        return next(new errors.ServerError('Unexpected error'));
      }
    });
};

export const getNotificationType = email => {
  debugEmail('getNotificationType', email);
  let tokens;
  if (email.match(/<.+@.+\..+>/)) {
    tokens = email.match(/<(.+)@(.+)\.opencollective\.com>/i);
  } else {
    tokens = email.match(/(.+)@(.+)\.opencollective\.com/i);
  }
  if (!tokens) {
    return {};
  }
  const collectiveSlug = tokens[2];
  let mailinglist = tokens[1];
  if (['info', 'hello', 'members', 'admins', 'admins'].indexOf(mailinglist) !== -1) {
    mailinglist = 'admins';
  }
  const type = `mailinglist.${mailinglist}`;
  const res = { collectiveSlug, mailinglist, type };
  debugEmail('getNotificationType', res);
  return res;
};

export const webhook = async (req, res, next) => {
  const email = req.body;
  const { recipient } = email;
  debugWebhook('>>> webhook received', JSON.stringify(email));
  const { mailinglist, collectiveSlug } = getNotificationType(recipient);

  if (!collectiveSlug) {
    return res.send(`Invalid recipient (${recipient}), skipping`);
  }

  debugWebhook(`email received for ${mailinglist} mailinglist of ${collectiveSlug}`);
  const body = email['body-html'] || email['body-plain'];

  let collective;

  // If receive an email that has already been processed, we skip it
  // (it happens since we send the approved email to the mailing list and add the recipients in /bcc)
  if (body.indexOf('<!-- OpenCollective.com -->') !== -1) {
    debugWebhook(`Email from ${email.from} with subject ${email.subject} already processed, skipping`);
    return res.send('Email already processed, skipping');
  }

  // If an email is sent to [info|hello|members|admins|organizers]@:collectiveSlug.opencollective.com,
  // we simply forward it to admins who subscribed to that mailinglist (no approval process)
  if (mailinglist === 'admins') {
    const collective = await models.Collective.findOne({ where: { slug: collectiveSlug } });
    if (!collective) {
      return res.send({
        error: { message: `This Collective doesn't exist or can't be emailed directly using this address` },
      });
    } else if (!get(collective.settings, 'features.forwardEmails') || !(await collective.canContact())) {
      return res.send({
        error: { message: `This Collective can't be emailed directly using this address` },
      });
    } else {
      return sendEmailToList(recipient, { subject: email.subject, body, from: email.from })
        .then(() => res.send('ok'))
        .catch(e => {
          logger.error(e);
          return next(new errors.ServerError('Unexpected error'));
        });
    }
  }

  // If the email is sent to :tierSlug or :eventSlug@:collectiveSlug.opencollective.com
  // We leave the original message on the mailgun server
  // and we send the email to the admins of the collective for approval
  // once approved, we will fetch the original email from the server and send it to all recipients
  let subscribers;
  try {
    collective = await models.Collective.findOne({ where: { slug: collectiveSlug } });
    if (!collective) {
      throw new Error('collective_not_found');
    }

    // We fetch all the recipients of that mailing list to give a preview in the approval email
    const results = await models.Notification.getSubscribersCollectives(collective.slug, mailinglist);
    debugWebhook('getSubscribers', mailinglist, results);
    if (results.length === 0) {
      throw new Error('no_subscribers');
    }
    subscribers = results.map(s => {
      if (s.image) {
        s.roundedAvatar = `https://res.cloudinary.com/opencollective/image/fetch/c_thumb,g_face,h_48,r_max,w_48,bo_3px_solid_white/c_thumb,h_48,r_max,w_48,bo_2px_solid_rgb:66C71A/e_trim/f_auto/${encodeURIComponent(
          s.image,
        )}`;
      } else {
        s.roundedAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(s.name)}&rounded=true&size=48`;
      }
      return s;
    });

    // We fetch all the admins of the collective to whom we will send the email to approve
    const admins = await sequelize.query(
      `
        SELECT * FROM "Users" u
        LEFT JOIN "Members" m ON m."CreatedByUserId"=u.id
        WHERE m."CollectiveId"=:collectiveid AND m.role=:role AND m."deletedAt" IS NULL
      `,
      {
        replacements: { collectiveid: collective.id, role: 'ADMIN' },
        model: models.User,
      },
    );
    if (admins.length === 0) {
      throw new Error('no_admins');
    }

    const messageId = email['message-url'].substr(email['message-url'].lastIndexOf('/') + 1);
    const mailserver = email['message-url'].substring(8, email['message-url'].indexOf('.'));
    const getData = user => {
      return {
        from: email.from,
        subject: email.subject,
        body: email['body-html'] || email['body-plain'],
        subscribers,
        latestSubscribers: subscribers.slice(0, 15),
        approveUrl: `${
          config.host.website
        }/api/services/email/approve?mailserver=${mailserver}&messageId=${messageId}&approver=${encodeURIComponent(
          user.email,
        )}`,
      };
    };
    // We send the email to each admin with
    // to: admins@:collectiveSlug.opencollective.com
    // bcc: admin.email
    // body: includes mailing list, recipients, preview of the email and approve button
    await Promise.map(admins, admin =>
      emailLib.send('email.approve', `admins@${collectiveSlug}.opencollective.com`, getData(admin), {
        bcc: admin.email,
      }),
    );

    res.send('Mailgun webhook processed successfully');
  } catch (e) {
    switch (e.message) {
      case 'no_subscribers':
        debugWebhook('No subscribers');
        /**
         * TODO
         * If there is no such mailing list,
         * - if the sender is a ADMIN, we send an email to confirm to create the mailing list
         *   with the people in /cc as initial subscribers
         * - if the sender is unknown, we return an email suggesting to contact info@:collectiveSlug.opencollective.com
         */
        return res.send({
          error: { message: `There is no user subscribed to ${recipient}` },
        });

      case 'mailinglist_not_found':
        debugWebhook('Mailing list not found');
        return res.send({
          error: {
            message: `Invalid mailing list address ${mailinglist}@${collectiveSlug}.opencollective.com`,
          },
        });

      case 'collective_not_found':
        debugWebhook('Collective not found');
        /**
         * TODO
         * If there is no such collective, we send an email to confirm to create the collective
         * with the people in /cc as initial admins
         */
        return res.send({
          error: {
            message: `There is no collective with slug ${collectiveSlug}`,
          },
        });

      case 'no_admins':
        return res.send({
          error: {
            message: `There is no admins to approve emails sent to ${email.recipient}`,
          },
        });

      default:
        logger.error(e);
        return next(new errors.ServerError('Unexpected error'));
    }
  }
};
