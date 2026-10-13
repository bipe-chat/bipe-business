import { test } from "node:test";
import assert from "node:assert/strict";
import { questionOptions, questionProblem, renderTemplate, SendRequest } from "../src/cloudapi.js";
import { checkHubSignature, checkPassword, findLinkCode, hashPassword, hubSignature, newLinkCode, normaliseLinkCode } from "../src/secrets.js";
import { Store } from "../src/store.js";
import { importTemplates } from "../src/templates.js";
import { parseWaWebhook } from "../src/whatsapp.js";

test("link codes: format, normalising and finding in a message", () => {
  for (let i = 0; i < 50; i++) assert.match(newLinkCode(), /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normaliseLinkCode("ab1c d2ef"), "AB1C-D2EF");
  assert.equal(normaliseLinkCode("oilx-0000"), "011X-0000");
  assert.equal(normaliseLinkCode("UUUU-0000"), null);
  assert.equal(normaliseLinkCode("OIL0-0000"), "0110-0000");
  assert.equal(normaliseLinkCode("short"), null);
  assert.equal(findLinkCode("Oi! continuar 7KQ2-M9XA por favor"), "7KQ2-M9XA");
  assert.equal(findLinkCode("CONTINUAR 7kq2m9xa"), "7KQ2-M9XA");
  assert.equal(findLinkCode("meu pedido é 7KQ2-M9XA"), null);
});

test("Meta webhook signature", () => {
  const body = '{"a":1}';
  const sig = hubSignature("s3cret", body);
  assert.ok(sig.startsWith("sha256="));
  assert.ok(checkHubSignature("s3cret", body, sig));
  assert.ok(!checkHubSignature("other", body, sig));
  assert.ok(!checkHubSignature("s3cret", body + " ", sig));
  assert.ok(!checkHubSignature("s3cret", body, undefined));
});

test("agent passwords", () => {
  const h = hashPassword("correct horse battery");
  assert.ok(checkPassword("correct horse battery", h));
  assert.ok(!checkPassword("wrong", h));
  assert.ok(!checkPassword("x", "plain"));
});

test("Cloud API shapes: text, template, buttons, list", () => {
  assert.equal(SendRequest.parse({ messaging_product: "whatsapp", to: "5511", type: "text", text: { body: "oi" } }).type, "text");
  const t = SendRequest.parse({ messaging_product: "bipe", to: "@a:b", type: "template", template: { name: "pedido", language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: "123" }] }] } });
  assert.equal(t.type, "template");
  if (t.type === "template") assert.equal(renderTemplate("Seu pedido {{1}} saiu. {{2}}", t.template.components), "Seu pedido 123 saiu. {{2}}");
  const b = SendRequest.parse({
    messaging_product: "bipe",
    to: "@a:b",
    type: "interactive",
    interactive: { type: "button", body: { text: "Confirma a consulta de amanhã às 14h?" }, action: { buttons: [{ type: "reply", reply: { id: "sim", title: "Confirmo" } }, { type: "reply", reply: { id: "remarcar", title: "Remarcar" } }] } },
  });
  assert.ok(b.type === "interactive");
  if (b.type === "interactive") {
    assert.deepEqual(questionOptions(b.interactive).map((o) => o.id), ["sim", "remarcar"]);
    assert.equal(questionProblem(b.interactive), null);
  }
  const tooMany = { type: "reply", reply: { id: "x", title: "x" } };
  assert.throws(() => SendRequest.parse({ messaging_product: "bipe", to: "x", type: "interactive", interactive: { type: "button", body: { text: "q" }, action: { buttons: [tooMany, tooMany, tooMany, tooMany] } } }));
  const l = SendRequest.parse({
    messaging_product: "bipe",
    to: "x",
    type: "interactive",
    interactive: { type: "list", body: { text: "Sobre o que é?" }, action: { button: "Ver opções", sections: [{ title: "Pedidos", rows: [{ id: "atraso", title: "Atraso" }, { id: "atraso", title: "Troca" }] }] } },
  });
  if (l.type === "interactive") assert.equal(questionProblem(l.interactive), "option ids must be unique");
});

test("Meta webhook parsing: text, button reply, list reply, statuses", () => {
  const p = parseWaWebhook({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1",
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ wa_id: "5511999", profile: { name: "Ana" } }],
              messages: [
                { from: "5511999", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body: "oi" } },
                { from: "5511999", id: "wamid.2", timestamp: "1700000001", type: "interactive", context: { id: "wamid.q" }, interactive: { type: "button_reply", button_reply: { id: "sim", title: "Confirmo" } } },
                { from: "5511999", id: "wamid.3", timestamp: "1700000002", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "troca", title: "Troca" } } },
              ],
              statuses: [{ id: "wamid.out", status: "read" }],
            },
          },
        ],
      },
    ],
  });
  assert.equal(p.messages.length, 3);
  assert.equal(p.messages[0]!.name, "Ana");
  assert.deepEqual(p.messages[1]!.reply, { id: "sim", title: "Confirmo" });
  assert.equal(p.messages[1]!.contextId, "wamid.q");
  assert.equal(p.messages[2]!.text, "Troca");
  assert.deepEqual(p.statuses, [{ id: "wamid.out", status: "read" }]);
  assert.deepEqual(parseWaWebhook(null), { messages: [], statuses: [] });
});

test("template import refuses marketing (ADR 0037)", () => {
  const s = new Store(":memory:");
  const r = importTemplates(s, {
    data: [
      { name: "pedido_saiu", language: "pt_BR", category: "UTILITY", components: [{ type: "BODY", text: "Seu pedido {{1}} saiu." }] },
      { name: "promo", language: "pt_BR", category: "MARKETING", components: [{ type: "BODY", text: "50% off!" }] },
      { name: "codigo", language: "pt_BR", category: "AUTHENTICATION", components: [{ type: "BODY", text: "Seu código é {{1}}." }] },
    ],
  });
  assert.deepEqual(r.done, ["pedido_saiu (pt_BR)", "codigo (pt_BR)"]);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0]!, /marketing/);
  assert.equal(s.template("pedido_saiu", "pt_BR")?.category, "utility");
});

test("store: conversations, link codes are single use, joining moves the old chat", () => {
  const s = new Store(":memory:");
  const wa = s.upsertConversation("whatsapp", "5511999", "5511999", "Ana").conv;
  assert.equal(s.upsertConversation("whatsapp", "5511999", "5511999", null).created, false);
  const bp = s.upsertConversation("bipe", "!room:x", "@ana:x", "Ana B").conv;
  const agent = s.addAgent({ email: "Bia@Loja.com", name: "Bia", role: "agent", password_hash: hashPassword("123456789012") });
  assert.equal(s.agentByEmail("bia@loja.com")?.id, agent.id);
  s.updateConversation(wa.id, { assignee_id: agent.id, tags: ["pedido"] });
  s.addLinkCode("AAAA-BBBB", wa.id, agent.id);
  assert.equal(s.useLinkCode("AAAA-BBBB", bp.id), wa.id);
  assert.equal(s.useLinkCode("AAAA-BBBB", bp.id), undefined);
  s.joinConversations(wa.id, bp.id);
  const after = s.conversation(bp.id)!;
  const old = s.conversation(wa.id)!;
  assert.equal(after.customer_id, old.customer_id);
  assert.equal(after.assignee_id, agent.id);
  assert.deepEqual(after.tags, ["pedido"]);
  assert.equal(old.status, "moved");
  assert.equal(old.moved_to, bp.id);
  // A new WhatsApp message does not reopen a moved chat.
  s.markInbound(old.id);
  assert.equal(s.conversation(old.id)!.status, "moved");
  // Expired codes do not work.
  s.addLinkCode("CCCC-DDDD", wa.id, agent.id, -1);
  assert.equal(s.useLinkCode("CCCC-DDDD", bp.id), undefined);
});

test("store: first response time and stats", () => {
  const s = new Store(":memory:");
  let t = 1_000_000;
  s.now = () => t;
  const c = s.upsertConversation("bipe", "!r:x", "@a:x", null).conv;
  s.markInbound(c.id);
  t += 60_000;
  s.markOutbound(c.id);
  t += 60_000;
  s.markOutbound(c.id);
  const st = s.stats(86_400_000);
  assert.equal(st.newByChannel.bipe, 1);
  assert.equal(st.medianFirstResponseMs, 60_000);
});
