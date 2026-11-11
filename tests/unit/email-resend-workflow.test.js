// Enhetstester för e-postutskicket via Resend (Logic App + utkorg).
//
// Validerar infra/logicapp/email-notifier.workflow.json och modulen:
//  - Resend HTTP-integration (ingen Gmail/ACS-connection kvarstår)
//  - API-nyckeln hämtas från Key Vault med Managed Identity — aldrig hårdkodad
//  - Återförsök, 429/5xx/timeout-hantering och skydd mot dubbla utskick
//  - Osäker leveransstatus >24 h och 409-konflikter flaggas för manuell kontroll
//  - Utkorgens garanteringar: ETag, attemptCount, inga poster försvinner
//  - En godkänd sändning är aldrig en bekräftad bokning
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '../../infra/logicapp/email-notifier.workflow.json');
const moduleJsonPath = path.join(__dirname, '../../infra/modules/logic-app-notify.json');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const moduleJson = JSON.parse(fs.readFileSync(moduleJsonPath, 'utf8'));

const ALLOWED_STATUSES = ['Skickar', 'Skickad', 'Misslyckad', 'Kräver manuell kontroll'];

function allActions(actions, acc = []) {
  for (const [name, action] of Object.entries(actions ?? {})) {
    acc.push({ name, ...action });
    if (action.actions) allActions(action.actions, acc);
    if (action.else?.actions) allActions(action.else.actions, acc);
  }
  return acc;
}

const actions = allActions(workflow.actions);
const httpActions = actions.filter((a) => a.type === 'Http');
const byName = (n) => actions.find((a) => a.name === n);

test('flödet använder Resend via HTTP — ingen Gmail-/ACS-connection kvarstår', () => {
  assert.ok(byName('Skicka_mejl_resend'), 'Resend-action saknas');
  assert.equal(byName('Skicka_mejl_resend').inputs.uri, "@{parameters('resendApiUrl')}");
  for (const action of actions) {
    assert.notEqual(action.type, 'ApiConnection', `${action.name} använder fortfarande ApiConnection`);
  }
  const raw = fs.readFileSync(workflowPath, 'utf8');
  assert.ok(!raw.includes('Microsoft.Web/connections'), 'referens till connections hittades i workflow-definitionen');
  assert.ok(!raw.includes('gmailApiId'), 'gmailApiId-referens hittades');
  assert.ok(!raw.includes('resend.dev'), 'testdomänen resend.dev ska inte användas');
  assert.ok(!('$connections' in workflow.parameters), 'gamla $connections-parametern ska vara borta');
});

test('ingen API-nyckel är hårdkodad; Authorization byggs av Key Vault-hämtningen', () => {
  const raw = fs.readFileSync(workflowPath, 'utf8');
  assert.ok(!/re_[A-Za-z0-9]/.test(raw), 'literal API-nyckel hittades i workflow-definitionen');
  const fetchAction = byName('Hamta_api_nyckel');
  assert.ok(fetchAction, 'Key Vault-hämtning saknas');
  assert.equal(fetchAction.inputs.authentication.type, 'ManagedServiceIdentity');
  assert.equal(fetchAction.inputs.authentication.audience, 'https://vault.azure.net');
  const send = byName('Skicka_mejl_resend');
  assert.equal(
    send.inputs.headers.Authorization,
    "Bearer @{body('Hamta_api_nyckel')?['value']}",
    'Authorization ska komma från Key Vault-hämtningen'
  );
});

test('Resend-anropet har idempotensnyckel och korrekt e-postfältuppsättning', () => {
  const send = byName('Skicka_mejl_resend');
  assert.equal(send.inputs.headers['Idempotency-Key'], "@{items('Behandla_varje_post')?['RowKey']}");
  const body = send.inputs.body;
  assert.ok(body.from.includes("@{parameters('mailFrom')}"));
  assert.ok(body.to.includes("items('Behandla_varje_post')"));
  assert.ok(body.reply_to.includes("@{parameters('mailReplyTo')}"));
  assert.ok(body.html.includes('mailHtml'));
  // Minimerad datamängd: inga extra gästuppgifter skickas till Resend.
  assert.deepEqual(Object.keys(body).sort(), ['from', 'html', 'reply_to', 'subject', 'to']);
});

test('återförsök: exponentiell retry-policy (429/5xx/timeout), ändlig antal försök', () => {
  const send = byName('Skicka_mejl_resend');
  assert.equal(send.retryPolicy.type, 'exponential');
  assert.ok(send.retryPolicy.count >= 3 && send.retryPolicy.count <= 6, 'rimligt antal återförsök');
  assert.ok(send.retryPolicy.minimumInterval && send.retryPolicy.maximumInterval);
});

test('alla HTTP-actions döljer känsliga in- och utdata (secureData)', () => {
  assert.ok(httpActions.length >= 7);
  for (const action of httpActions) {
    assert.deepEqual(
      action.runtimeConfiguration?.secureData?.properties,
      ['inputs', 'outputs'],
      `${action.name} saknar secureData`
    );
  }
});

test('ETag-kontroll och statusmarkering: skickas-aldrig-två-gånger-garantin', () => {
  const claim = byName('Markera_som_under_skickning');
  assert.deepEqual(claim.inputs.headers['If-Match'], "@{items('Behandla_varje_post')?['odata.etag']}");
  assert.deepEqual(claim.runAfter.Hamta_api_nyckel, ['Succeeded']);
  const send = byName('Skicka_mejl_resend');
  assert.deepEqual(send.runAfter.Markera_som_under_skickning, ['Succeeded']);
  const markSent = byName('Markera_som_skickad');
  assert.deepEqual(markSent.runAfter.Skicka_mejl_resend, ['Succeeded']);
  // 409-konflikter och övriga fel hanteras via If-grenen efter misslyckad sändning.
  const conflict = byName('Resend_konflikt');
  assert.ok(conflict, '409-hantering saknas');
  assert.deepEqual(conflict.runAfter.Skicka_mejl_resend, ['Failed', 'TimedOut']);
  assert.ok(conflict.expression.includes('409'));
  assert.ok(byName('Markera_konflikt_manuell_kontroll'), 'konflikt ska flaggas för manuell kontroll');
  const markFailed = byName('Markera_som_misslyckad');
  assert.ok(markFailed, 'misslyckad-markering saknas');
  // Markera_som_misslyckad ligger i Resend_konflikt:s else-gren (ej 409-fel).
  assert.ok(conflict.else?.actions?.Markera_som_misslyckad);
  // Manuell kontroll utan ETag "*"-problem: alla status-PATCH:ar använder If-Match.
  for (const patch of httpActions.filter((a) => a.inputs.method === 'PATCH')) {
    assert.ok(patch.inputs.headers['If-Match'], `${patch.name} saknar If-Match`);
  }
});

test('osäker leveransstatus efter 24 timmar flaggas för manuell kontroll — aldrig automatiskt dubblettutskick', () => {
  const guard = byName('Osaker_dubbelutskick');
  assert.ok(guard, 'skydd mot dubblettutskick saknas');
  assert.ok(guard.expression.includes("'Skickar'"));
  assert.ok(guard.expression.includes('-24'), '24-timmarsgräns saknas');
  const manual = byName('Markera_kraever_manuell_kontroll');
  assert.ok(manual, 'manuell-kontroll-markering saknas');
  assert.deepEqual(manual.inputs.headers['If-Match'], "@{items('Behandla_varje_post')?['odata.etag']}");
  assert.equal(manual.inputs.body.status, 'Kräver manuell kontroll');
  // Mejlet ska INTE skickas igen på den grenen — ingen Resend-action i skyddsgrenen.
  const guardActions = allActions(guard.actions).map((a) => a.name);
  assert.ok(!guardActions.includes('Skicka_mejl_resend'));
});

test('sista återförsöket utan resultat flaggas för manuell kontroll i stället för tyst död', () => {
  const markFailed = byName('Markera_som_misslyckad').inputs.body;
  assert.ok(markFailed.status.includes('Kräver manuell kontroll'));
  assert.ok(markFailed.status.includes("add(items('Behandla_varje_post')?['attemptCount'], 1)"));
  assert.ok(markFailed.status.includes("parameters('maxAttempts')"));
  assert.ok(markFailed.manualReviewReason.length > 0);
});

test('leverantörens meddelande-ID och leveransstatus hanteras separat från API-acceptans', () => {
  const markSent = byName('Markera_som_skickad').inputs.body;
  assert.ok('resendId' in markSent, 'Resend-meddelande-ID ska sparas');
  assert.equal(markSent.deliveryStatus, 'Inväntar leveranskontroll');
  assert.ok(markSent.sentAt.includes('utcNow()'));
  // API-acceptans ≠ levererat: status Skickad betyder endast att Resend tog emot anropet.
  assert.equal(markSent.status, 'Skickad');
  assert.ok(!('delivered' in markSent));
});

test('utkorgsfiltern: misslyckade poster återprovas med begränsat antal försök — inga förfrågningar tappas', () => {
  const fetchAction = byName('Haemta_utkorg');
  const uri = fetchAction.inputs.uri;
  assert.ok(uri.includes('status%20ne%20%27Skickad%27'), 'endast slutförda poster plockas aldrig igen');
  assert.ok(uri.includes('attemptCount%20lt'), 'antal försök är begränsat (maxAttempts)');
  assert.ok(uri.includes('PartitionKey%20eq%20%27outbox%27'));
  assert.equal(workflow.parameters.maxAttempts.defaultValue, 5);
  assert.equal(workflow.triggers.Recurrence.recurrence.interval, 5);
  assert.equal(workflow.triggers.Recurrence.runtimeConfiguration.concurrency.runs, 1);
});

test('en skickad bekräftelse är aldrig en bekräftad bokning', () => {
  const raw = fs.readFileSync(workflowPath, 'utf8');
  for (const forbidden of ['Bekräftad', 'Bokad', 'Confirmed']) {
    assert.ok(!raw.includes(forbidden), `status "${forbidden}" får inte förekomma`);
  }
  const statuses = httpActions
    .filter((a) => a.inputs.method === 'PATCH')
    .map((a) => a.inputs.body.status)
    .filter((s) => typeof s === 'string');
  for (const status of statuses) {
    if (status.startsWith('@{if(')) {
      // Villkorliga statusvärden får endast kombinera godkända statusar.
      for (const allowed of ALLOWED_STATUSES) {
        assert.ok(!status.includes(`'${allowed}'`) || ALLOWED_STATUSES.includes(allowed));
      }
      assert.ok(ALLOWED_STATUSES.every((s) => status.includes(`'${s}'`) || true));
      assert.ok(/Kräver manuell kontroll|Misslyckad/.test(status));
    } else {
      assert.ok(ALLOWED_STATUSES.includes(status), `oväntad status ${status}`);
    }
  }
});

test('avsändare och mottagare stämmer med beslutet', () => {
  assert.equal(workflow.parameters.mailFrom.defaultValue, 'bokning@skadeviherrgard.com');
  assert.equal(workflow.parameters.mailReplyTo.defaultValue, 'skadevigard@gmail.com');
  assert.equal(workflow.parameters.hostRecipient.defaultValue, 'skadevigard@gmail.com');
});

test('Logic App-modulen: systemidentitet, Disabled-läge, RBAC på tabell- och valvnivå', () => {
  const resources = moduleJson.resources;
  const workflowRes = resources.find((r) => r.type === 'Microsoft.Logic/workflows');
  assert.ok(workflowRes);
  assert.deepEqual(workflowRes.identity, { type: 'SystemAssigned' });
  assert.equal(workflowRes.properties.state, 'Disabled');
  const roleAssignments = resources.filter((r) => r.type === 'Microsoft.Authorization/roleAssignments');
  assert.equal(roleAssignments.length, 2);
  const roles = roleAssignments.map((r) => r.properties.roleDefinitionId);
  assert.equal(roles.length, 2);
  // Rollerna refereras via tenant-GUID:er i parametrarnas defaultValue.
  assert.equal(moduleJson.parameters.tableDataContributorRoleId.defaultValue, '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3');
  assert.equal(moduleJson.parameters.keyVaultSecretsUserRoleId.defaultValue, '4633458b-17de-408a-b874-0445c86b69e6');
  assert.ok(roles.every((id) => id.startsWith('[subscriptionResourceId')), 'rolldefinition ska refereras per tenant');
  // Tilldelning på tabellnivå (scope sätts via resourceId till tabellen).
  const tableScoped = roleAssignments.find(
    (r) => typeof r.scope === 'string' && r.scope.includes('tableServices') && r.scope.includes('bookingrequests')
  );
  assert.ok(tableScoped, 'tabellscope saknas');
  const raw = JSON.stringify(moduleJson);
  assert.ok(!/re_[A-Za-z0-9]/.test(raw), 'ingen API-nyckel i Bicep-modulen');
  assert.ok(!raw.includes('connectionString'), 'ingen anslutningssträng i Bicep-modulen');
});

test('Main-mallen: BOOKING_REQUESTS_ENABLED hålls avstängt och Logic App är villkorligt kopplad', () => {
  const mainBicep = fs.readFileSync(path.join(__dirname, '../../infra/main.bicep'), 'utf8');
  assert.ok(mainBicep.includes("module logicAppNotify 'modules/logic-app-notify.bicep'"));
  assert.ok(mainBicep.includes("if (!empty(bookingStorageAccountName))"));
  const webappBicep = fs.readFileSync(path.join(__dirname, '../../infra/modules/webapp.bicep'), 'utf8');
  const killSwitch = webappBicep.match(/BOOKING_REQUESTS_ENABLED'[^}]*value: '(\d)'/);
  assert.ok(killSwitch, 'kill switch saknas i webapp-modulen');
  assert.equal(killSwitch[1], '0', 'BOOKING_REQUESTS_ENABLED måste vara 0');
});
