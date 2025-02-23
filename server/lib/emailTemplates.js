import fs from 'fs';

import handlebars from './handlebars';

/*
 * Loads all the email templates
 */

const templates = {};

export const templateNames = [
  'announcement',
  'announcement.text',
  'archived.collective',
  'email.approve',
  'email.message',
  'github.signup',
  'collective.apply',
  'collective.apply.for.host',
  'collective.approved',
  'collective.approved.the-social-change-nest',
  'collective.rejected',
  'collective.comment.created',
  'collective.conversation.created',
  'collective.confirm',
  'collective.created',
  'collective.created.the-social-change-nest',
  'collective.contact',
  'collective.created.opensource',
  'collective.expense.approved',
  'collective.expense.approved.for.host',
  'collective.expense.created',
  'collective.expense.processing',
  'collective.expense.error',
  'collective.expense.error.for.host',
  'collective.expense.paid',
  'collective.expense.paid.for.host',
  'collective.expense.invite.drafted',
  'collective.expense.missing.receipt',
  'collective.expense.rejected',
  'collective.member.created',
  'collective.monthlyreport',
  'collective.monthlyreport.text',
  'collective.newmember',
  'collective.update.published',
  'confirm-guest-account',
  'event.newmember',
  'event.reminder.1d',
  'event.reminder.7d',
  'fund.created.foundation',
  'fund.approved.foundation',
  'host.application.contact',
  'host.report',
  'host.report.text',
  'host.report.summary',
  'member.invitation',
  'onboarding.day2',
  'onboarding.day2.opensource',
  'onboarding.day2.organization',
  'onboarding.day3',
  'onboarding.day3.opensource',
  'onboarding.noExpenses',
  'onboarding.noExpenses.opensource',
  'onboarding.noUpdates',
  'onboarding.day21.noTwitter',
  'onboarding.day7',
  'onboarding.day35.active',
  'onboarding.day35.inactive',
  'organization.collective.created',
  'organization.newmember',
  'payment.failed',
  'payment.failed.text',
  'payment.creditcard.confirmation',
  'payment.creditcard.confirmation.text',
  'payment.creditcard.expiring',
  'order.processing',
  'order.new.pendingFinancialContribution',
  'order.reminder.pendingFinancialContribution',
  'report.platform',
  'report.platform.weekly',
  'subscription.canceled',
  'ticket.confirmed',
  'ticket.confirmed.text',
  'ticket.confirmed.fearlesscitiesbrussels',
  'ticket.confirmed.open-2020',
  'thankyou',
  'thankyou.chsf',
  'thankyou.sustainoss',
  'thankyou.wwcode',
  'thankyou.kendraio',
  'thankyou.brusselstogether',
  'thankyou.fearlesscitiesbrussels',
  'thankyou.ispcwa',
  'thankyou.fr',
  'thankyou.laprimaire',
  'thankyou.foundation',
  'thankyou.opensource',
  'user.card.claimed',
  'user.card.claimed.text',
  'user.card.invited',
  'user.card.invited.text',
  'user.changeEmail',
  'user.changeEmail.text',
  'user.forgot.password',
  'user.monthlyreport',
  'user.monthlyreport.text',
  'user.new.token',
  'user.new.token.text',
  'user.yearlyreport',
  'user.yearlyreport.text',
  'backyourstack.dispatch.confirmed',
  'added.fund.to.org',
  'activated.collective.as.host',
  'deactivated.collective.as.host',
  'hostedCollectives.freePlan.limit.reached',
  'hostedCollectives.otherPlans.limit.reached',
  'hostplan.renewal.thankyou',
  'hostplan.first.subscription.confirmation',
  'hostplan.upgrade.subscription.confirmation',
  'contribution.rejected',
  'virtualcard.requested',
];

const templatesPath = `${__dirname}/../../templates`;

// Register partials
const header = fs.readFileSync(`${templatesPath}/partials/header.hbs`, 'utf8');
const footer = fs.readFileSync(`${templatesPath}/partials/footer.hbs`, 'utf8');
const footertxt = fs.readFileSync(`${templatesPath}/partials/footer.text.hbs`, 'utf8');
const toplogo = fs.readFileSync(`${templatesPath}/partials/toplogo.hbs`, 'utf8');
const eventsnippet = fs.readFileSync(`${templatesPath}/partials/eventsnippet.hbs`, 'utf8');
const expenseItems = fs.readFileSync(`${templatesPath}/partials/expense-items.hbs`, 'utf8');
const eventdata = fs.readFileSync(`${templatesPath}/partials/eventdata.hbs`, 'utf8');
const collectivecard = fs.readFileSync(`${templatesPath}/partials/collectivecard.hbs`, 'utf8');
const chargeDateNotice = fs.readFileSync(`${templatesPath}/partials/charge_date_notice.hbs`, 'utf8');
const mthReportFooter = fs.readFileSync(`${templatesPath}/partials/monthlyreport.footer.hbs`, 'utf8');
const mthReportSubscription = fs.readFileSync(`${templatesPath}/partials/monthlyreport.subscription.hbs`, 'utf8');

handlebars.registerPartial('header', header);
handlebars.registerPartial('footer', footer);
handlebars.registerPartial('footer.text', footertxt);
handlebars.registerPartial('toplogo', toplogo);
handlebars.registerPartial('collectivecard', collectivecard);
handlebars.registerPartial('eventsnippet', eventsnippet);
handlebars.registerPartial('expenseItems', expenseItems);
handlebars.registerPartial('eventdata', eventdata);
handlebars.registerPartial('charge_date_notice', chargeDateNotice);
handlebars.registerPartial('mr-footer', mthReportFooter);
handlebars.registerPartial('mr-subscription', mthReportSubscription);

templateNames.forEach(template => {
  const source = fs.readFileSync(`${templatesPath}/emails/${template}.hbs`, 'utf8');
  templates[template] = handlebars.compile(source);
});

export default templates;
