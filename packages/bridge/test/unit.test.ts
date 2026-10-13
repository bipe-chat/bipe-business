import { test } from "node:test";
import assert from "node:assert/strict";
import { questionFallback, questionProblem, renderTemplate, SendRequest } from "../src/api.js";
import { checkPassword, checkWebhookSignature, hashPassword, webhookSignature } from "../src/secrets.js";
import { Store } from "../src/store.js";
import { importTemplates } from "../src/templates.js";

test("webhook signature: timestamped, body-bound, replay window", () => {
  const body = '{"a":1}';
  const sig = webhookSignature("s3cret", body, 1_700_000_000);
  assert.match(sig, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.ok(checkWebhookSignature("s3cret", body, sig, 1_700_000_100));
  assert.ok(!checkWebhookSignature("other", body, sig, 1_700_000_100));
  assert.ok(!checkWebhookSignature("s3cret", body + " ", sig, 1_700_000_100));
  assert.ok(!checkWebhookSignature("s3cret", body, sig, 1_700_001_000));
  assert.ok(!checkWebhookSignature("s3cret", body, undefined, 1_700_000_100));
});

test("agent passwords", () => {
  const h = hashPassword("correct horse battery");
  assert.ok(checkPassword("correct horse battery", h));
  assert.ok(!checkPassword("wrong", h));
  assert.ok(!checkPassword("x", "plain"));
});

test("send requests: text, template, question, exactly one", () => {
  const t = SendRequest.parse({ to: "@ana", text: "oi" });
  assert.deepEqual(t, { to: "@ana", content: { text: "oi" } });
  const tp = SendRequest.parse({ to: "@ana", template: { name: "pedido", language: "pt-BR", params: ["123"] } });
  assert.ok("template" in tp.content);
  assert.equal(renderTemplate("Seu pedido {1} saiu. {2}", ["123"]), "Seu pedido 123 saiu. {2}");
  const q = SendRequest.parse({ to: "@ana", question: { text: "Confirma a consulta de amanhã às 14h?", options: [{ id: "sim", label: "Confirmo" }, { id: "remarcar", label: "Remarcar" }] } });
  assert.ok("question" in q.content);
  if ("question" in q.content) {
    assert.equal(questionProblem(q.content.question), null);
    assert.equal(questionFallback(q.content.question), "Confirma a consulta de amanhã às 14h?\n1. Confirmo\n2. Remarcar");
  }
  assert.throws(() => SendRequest.parse({ to: "@ana" }));
  assert.throws(() => SendRequest.parse({ to: "@ana", text: "oi", question: { text: "q", options: [{ id: "a", label: "a" }, { id: "b", label: "b" }] } }));
  assert.throws(() => SendRequest.parse({ to: "@ana", question: { text: "q", options: [{ id: "a", label: "a" }] } }));
  const eleven = Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, label: `O${i}` }));
  assert.throws(() => SendRequest.parse({ to: "@ana", question: { text: "q", options: eleven } }));
  const dup = SendRequest.parse({ to: "x", question: { text: "Sobre o que é?", options: [{ id: "a", label: "Atraso" }, { id: "a", label: "Troca" }] } });
  if ("question" in dup.content) assert.equal(questionProblem(dup.content.question), "option ids must be unique");
});

test("template import refuses marketing (ADR 0037)", () => {
  const s = new Store(":memory:");
  const r = importTemplates(s, [
    { name: "pedido_saiu", language: "pt-BR", category: "utility", body: "Seu pedido {1} saiu." },
    { name: "promo", language: "pt-BR", category: "marketing", body: "50% off!" },
    { name: "codigo", language: "pt-BR", category: "authentication", body: "Seu código é {1}." },
    { name: "Bad Name", language: "pt-BR", category: "utility", body: "x" },
  ]);
  assert.deepEqual(r.done, ["pedido_saiu (pt-BR)", "codigo (pt-BR)"]);
  assert.equal(r.refused.length, 2);
  assert.match(r.refused[0]!, /marketing/);
  assert.equal(s.template("pedido_saiu", "pt-BR")?.category, "utility");
});

test("store: conversations by room, a new message opens a solved chat", () => {
  const s = new Store(":memory:");
  const c = s.upsertConversation("!room:x", "@ana:x", "Ana").conv;
  assert.equal(s.upsertConversation("!room:x", "@ana:x", null).created, false);
  assert.equal(s.conversationByRoom("!room:x")?.id, c.id);
  const agent = s.addAgent({ email: "Bia@Loja.com", name: "Bia", role: "agent", password_hash: hashPassword("123456789012") });
  assert.equal(s.agentByEmail("bia@loja.com")?.id, agent.id);
  s.updateConversation(c.id, { status: "solved", tags: ["pedido"] });
  s.markInbound(c.id);
  assert.equal(s.conversation(c.id)!.status, "open");
  assert.deepEqual(s.conversation(c.id)!.tags, ["pedido"]);
});

test("store: first response time and stats", () => {
  const s = new Store(":memory:");
  let t = 1_000_000;
  s.now = () => t;
  const c = s.upsertConversation("!r:x", "@a:x", null).conv;
  s.markInbound(c.id);
  t += 60_000;
  s.markOutbound(c.id);
  t += 60_000;
  s.markOutbound(c.id);
  const st = s.stats(86_400_000);
  assert.equal(st.newConversations, 1);
  assert.equal(st.medianFirstResponseMs, 60_000);
});
