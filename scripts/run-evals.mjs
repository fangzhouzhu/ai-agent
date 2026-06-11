import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function readJson(relativePath) {
  const filePath = path.join(root, relativePath);
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateAgentRouting() {
  const cases = readJson("evals/agent-routing.json");
  assert(Array.isArray(cases), "agent-routing.json must be an array");
  for (const item of cases) {
    assert(item.id, "agent-routing case is missing id");
    assert(item.input, `${item.id} is missing input`);
    assert(
      ["chat", "agent", "rag"].includes(item.expectedRoute),
      `${item.id} has invalid expectedRoute`,
    );
    if (item.expectedTools) {
      assert(Array.isArray(item.expectedTools), `${item.id} expectedTools must be an array`);
    }
  }
  return cases.length;
}

function validateRagCitations() {
  const cases = readJson("evals/rag-citations.json");
  assert(Array.isArray(cases), "rag-citations.json must be an array");
  for (const item of cases) {
    assert(item.id, "rag-citations case is missing id");
    assert(item.question, `${item.id} is missing question`);
    assert(
      Array.isArray(item.expectedAnswerFeatures) &&
        item.expectedAnswerFeatures.length > 0,
      `${item.id} must describe expectedAnswerFeatures`,
    );
  }
  return cases.length;
}

const results = [
  ["agent-routing", validateAgentRouting()],
  ["rag-citations", validateRagCitations()],
];

for (const [name, count] of results) {
  console.log(`✓ ${name}: ${count} cases`);
}

console.log("Eval schema checks passed.");
