import test from 'node:test';
import assert from 'node:assert/strict';
import { openConversationInViewer } from '../crm-ui/crm-assets/followups-ui.js';

function node() {
  return { textContent: '', children: [], append(...v) { this.children.push(...v); },
    replaceChildren(...v) { this.children = [...v]; }, addEventListener() {} };
}
function text(n) { return [n.textContent, ...n.children.map(text)].join(' '); }

test('metadata-only viewer states original messages are unavailable', async () => {
  const viewer = node();
  const old = globalThis.document;
  globalThis.document = { createElement: node, getElementById: id => id === 'conversation-viewer' ? viewer : null };
  try {
    await openConversationInViewer('conv-test', {
      api: () => ({ getConversation: async () => ({
        conversation: { chat_title: 'تجريبي', source_ref: 'antix_metadata_v1', message_count: 8,
          raw_text: '', parse_warnings: [] }, messages: [], insights: null,
      }) }),
      errorText: e => String(e),
    });
    const rendered = text(viewer);
    assert.match(rendered, /8 رسالة في المصدر/);
    assert.match(rendered, /نص المحادثة غير محفوظ/);
    assert.doesNotMatch(rendered, /عرض النص الخام الأصلي الكامل|0 رسالة/);
  } finally { globalThis.document = old; }
});
