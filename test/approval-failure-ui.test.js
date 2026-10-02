import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ApprovalReviewFailureNotice } from '../host-adapter/upstream/packages/ui/src/components/ApprovalReviewFailureNotice.tsx';
import zhCN from '../host-adapter/upstream/packages/ui/src/i18n/locales/zh-CN.ts';
import enUS from '../host-adapter/upstream/packages/ui/src/i18n/locales/en-US.ts';

const require = createRequire(new URL('../host-adapter/upstream/packages/ui/package.json', import.meta.url));
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const render = (messages, failure) => renderToStaticMarkup(createElement(ApprovalReviewFailureNotice, {
  failure, intl: { formatMessage: ({ id }, values = {}) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), messages[id]) },
}));
for (const [locale, messages, manual, statusLabel, requestLabel] of [
  ['zh-CN', zhCN, '人工处理', 'HTTP 状态码', '请求编号'],
  ['en-US', enUS, 'manually', 'HTTP status', 'Request ID'],
]) test(`provider interception notice renders safe diagnostics and existing settings path in ${locale}`, () => {
  const html = render(messages, { code: 'provider_request_blocked', message: 'request blocked <script>unsafe</script>', httpStatus: 405, requestId: 'fixture-request' });
  assert.match(html, new RegExp(manual));
  assert.match(html, /CodexAutoApproval/);
  assert.match(html, new RegExp(statusLabel));
  assert.match(html, new RegExp(requestLabel));
  assert.match(html, /405/);
  assert.match(html, /fixture-request/);
  assert.doesNotMatch(html, /<script>/);
  const ordinary = render(messages, { code: 'model_request_failed', message: 'Method Not Allowed' });
  assert.match(ordinary, /Method Not Allowed/);
  assert.doesNotMatch(ordinary, /CodexAutoApproval|HTTP status|HTTP 状态码|Request ID|请求编号/);
});
