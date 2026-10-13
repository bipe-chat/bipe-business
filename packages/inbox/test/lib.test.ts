import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTag,
  buildInteractive,
  contactLabel,
  displayName,
  fillVariables,
  firstName,
  formatDateTime,
  formatDuration,
  formatWhen,
  matchReplies,
  optionIds,
  questionProblems,
  readPoll,
  readPollResponse,
  slashQuery,
  slugify,
  titleLimit,
  waWindowOpen,
} from "../src/lib.ts";

const TZ = "America/Sao_Paulo";

test("slugify and option ids", () => {
  assert.equal(slugify("Outro dia"), "outro-dia");
  assert.equal(slugify("  Não, obrigado!  "), "nao-obrigado");
  assert.equal(slugify("Ação & Reação"), "acao-reacao");
  assert.equal(slugify("!!!"), "opcao");
  assert.deepEqual(optionIds(["Sim", "sim", "Não", "SIM"]), ["sim", "sim-2", "nao", "sim-3"]);
});

test("title limits: 20 for buttons, 24 for list rows", () => {
  assert.equal(titleLimit(2), 20);
  assert.equal(titleLimit(3), 20);
  assert.equal(titleLimit(4), 24);
});

test("question validation", () => {
  assert.deepEqual(questionProblems("Quer receber amanhã?", ["Sim", "Outro dia"]), []);
  assert.ok(questionProblems("", ["Sim", "Não"]).includes("Escreva a pergunta."));
  assert.ok(questionProblems("P?", ["Sim"]).includes("Coloque pelo menos 2 opções."));
  assert.ok(questionProblems("P?", Array.from({ length: 11 }, (_, i) => `Opção ${i}`)).includes("Coloque no máximo 10 opções."));
  assert.ok(questionProblems("P?", ["Sim", " "]).includes("Tem uma opção vazia."));
  assert.ok(questionProblems("P?", ["Sim", "sim"]).includes("Duas opções têm o mesmo texto."));
  // 21 characters: too long for a button, fine for a list row.
  const t21 = "a".repeat(21);
  assert.ok(questionProblems("P?", ["Sim", t21]).includes("A opção 2 tem mais de 20 caracteres."));
  assert.deepEqual(questionProblems("P?", ["Sim", "Não", "Talvez", t21]), []);
  assert.ok(questionProblems("P?", ["Sim", "Não", "Talvez", "b".repeat(25)]).includes("A opção 4 tem mais de 24 caracteres."));
});

test("interactive object: buttons for 2 to 3 options, list for 4 to 10", () => {
  assert.deepEqual(buildInteractive(" Quer receber amanhã? ", ["Sim", "Outro dia"]), {
    type: "button",
    body: { text: "Quer receber amanhã?" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "sim", title: "Sim" } },
        { type: "reply", reply: { id: "outro-dia", title: "Outro dia" } },
      ],
    },
  });
  const list = buildInteractive("Qual horário?", ["Manhã", "Tarde", "Noite", "Tanto faz"]);
  assert.equal(list.type, "list");
  assert.ok(list.type === "list");
  assert.equal(list.action.button, "Ver opções");
  assert.equal(list.action.sections.length, 1);
  assert.deepEqual(list.action.sections[0]!.rows.map((r) => r.id), ["manha", "tarde", "noite", "tanto-faz"]);
});

test("saved replies: variables and slash query", () => {
  assert.equal(firstName("  Ana Paula Souza "), "Ana");
  assert.equal(firstName(null), "");
  assert.equal(fillVariables("Oi {nome}, tudo certo?", { nome: "Ana" }), "Oi Ana, tudo certo?");
  assert.equal(fillVariables("Oi {nome}, pedido {pedido}.", { nome: "" }), "Oi {nome}, pedido {pedido}.");
  assert.equal(fillVariables("Oi {Nome}", { nome: "Bia" }), "Oi Bia");
  assert.deepEqual(slashQuery("/ola", 4), { query: "ola", start: 0 });
  assert.deepEqual(slashQuery("Oi /pra", 7), { query: "pra", start: 3 });
  assert.deepEqual(slashQuery("/", 1), { query: "", start: 0 });
  assert.equal(slashQuery("e/ou", 4), null);
  assert.equal(slashQuery("/ola mundo", 10), null);
  const replies = [{ shortcut: "prazo" }, { shortcut: "ola" }, { shortcut: "novo-prazo" }];
  assert.deepEqual(matchReplies(replies, "pra").map((r) => r.shortcut), ["prazo", "novo-prazo"]);
});

test("time in pt-BR", () => {
  const now = Date.UTC(2026, 9, 13, 18, 0); // 13 out 2026, 15:00 in São Paulo
  assert.equal(formatWhen(Date.UTC(2026, 9, 13, 17, 30), now, TZ), "14:30");
  assert.equal(formatWhen(Date.UTC(2026, 9, 12, 17, 30), now, TZ), "ontem");
  assert.equal(formatWhen(Date.UTC(2026, 8, 2, 17, 30), now, TZ), "2 set");
  assert.equal(formatWhen(Date.UTC(2025, 9, 13, 17, 30), now, TZ), "13/10/2025");
  assert.equal(formatWhen(null, now, TZ), "");
  assert.equal(formatDateTime(Date.UTC(2026, 9, 13, 17, 30), TZ), "13/10/2026 14:30");
  assert.equal(formatDuration(40_000), "40 s");
  assert.equal(formatDuration(12 * 60_000), "12 min");
  assert.equal(formatDuration(125 * 60_000), "2 h 5 min");
  assert.equal(formatDuration(120 * 60_000), "2 h");
  assert.equal(formatDuration(76 * 3_600_000), "3 d 4 h");
  assert.equal(formatDuration(null), "");
  assert.equal(waWindowOpen(now - 3_600_000, now), true);
  assert.equal(waWindowOpen(now - 25 * 3_600_000, now), false);
  assert.equal(waWindowOpen(null, now), false);
});

test("contacts: a Bipe contact never shows a phone number", () => {
  assert.equal(contactLabel("bipe", "@ana:bipe.net.br"), "@ana:bipe.net.br");
  assert.equal(contactLabel("bipe", "5511987654321"), "");
  assert.equal(contactLabel("bipe", "+55 11 98765-4321"), "");
  assert.equal(contactLabel("whatsapp", "5511987654321"), "+55 11 98765-4321");
  assert.equal(contactLabel("whatsapp", "551134567890"), "+55 11 3456-7890");
  assert.equal(contactLabel("whatsapp", "14155550100"), "+14155550100");
  assert.equal(displayName({ channel: "bipe", contact: "5511987654321", contact_name: null }), "Cliente");
  assert.equal(displayName({ channel: "bipe", contact: "@ana:bipe.net.br", contact_name: " Ana " }), "Ana");
});

test("polls: start and response, stable and unstable", () => {
  const unstable = {
    "org.matrix.msc3381.poll.start": {
      kind: "org.matrix.msc3381.poll.disclosed",
      max_selections: 1,
      question: { "org.matrix.msc1767.text": "Quer receber amanhã?", body: "Quer receber amanhã?", msgtype: "m.text" },
      answers: [
        { id: "sim", "org.matrix.msc1767.text": "Sim" },
        { id: "outro", "org.matrix.msc1767.text": "Outro dia" },
      ],
    },
    body: "fallback",
  };
  assert.deepEqual(readPoll(unstable), { question: "Quer receber amanhã?", answers: [{ id: "sim", title: "Sim" }, { id: "outro", title: "Outro dia" }] });
  const stable = {
    "m.poll": {
      question: { "m.text": [{ body: "Qual?" }] },
      answers: [{ "m.id": "a", "m.text": [{ mimetype: "text/html", body: "<b>A</b>" }, { body: "A" }] }],
    },
  };
  assert.deepEqual(readPoll(stable), { question: "Qual?", answers: [{ id: "a", title: "A" }] });
  assert.equal(readPoll({ body: "oi" }), null);
  assert.deepEqual(readPollResponse({ "m.relates_to": { rel_type: "m.reference", event_id: "$q" }, "org.matrix.msc3381.poll.response": { answers: ["outro"] } }), { pollId: "$q", answers: ["outro"] });
  assert.deepEqual(readPollResponse({ "m.relates_to": { event_id: "$q" }, "m.selections": ["a"] }), { pollId: "$q", answers: ["a"] });
  assert.equal(readPollResponse({ "org.matrix.msc3381.poll.response": { answers: ["x"] } }), null);
});

test("tags", () => {
  assert.deepEqual(addTag(["entrega"], "  troca   de produto "), ["entrega", "troca de produto"]);
  assert.deepEqual(addTag(["entrega"], "Entrega"), ["entrega"]);
  assert.deepEqual(addTag(["entrega"], "   "), ["entrega"]);
});
