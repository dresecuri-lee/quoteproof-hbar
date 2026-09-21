import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../template.json", import.meta.url), "utf8"));
const block = manifest["create-scaffold-hbar"];
const allowed = {
  frontend: new Set(["nextjs-app", "none"]),
  solidityFramework: new Set(["hardhat", "foundry", "none"]),
  packageManager: new Set(["yarn", "npm", "none"]),
};

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

requireValue(typeof manifest.name === "string" && manifest.name.length > 0, "name must be a non-empty string");
requireValue(block && typeof block === "object", "create-scaffold-hbar block is required");

for (const [key, values] of Object.entries(block.capabilities ?? {})) {
  requireValue(allowed[key], `unknown capability ${key}`);
  requireValue(Array.isArray(values) && values.length > 0, `${key} capabilities must be a non-empty array`);
  requireValue(values.every(value => allowed[key].has(value)), `${key} has an unsupported value`);
  const selected = block.defaults?.[key];
  requireValue(selected === undefined || values.includes(selected), `${key} default is not an allowed capability`);
}

for (const [tool, range] of Object.entries(block.requirements ?? {})) {
  requireValue(tool.length > 0 && typeof range === "string" && range.length > 0, "requirements must map tools to ranges");
}

for (const envVar of block.envVars ?? []) {
  requireValue(typeof envVar.key === "string" && envVar.key.length > 0, "environment variable key is required");
  requireValue(typeof envVar.description === "string", "environment variable description must be a string");
}

const sections = block.outro?.sections;
requireValue(Array.isArray(sections) && sections.length > 0, "outro.sections must be a non-empty array");
for (const section of sections) {
  requireValue(Array.isArray(section.steps) && section.steps.length > 0, "each outro section needs steps");
  for (const step of section.steps) {
    requireValue(
      ["label", "command", "url", "text"].some(key => typeof step[key] === "string" && step[key].length > 0),
      "each outro step needs label, command, url, or text",
    );
  }
}

console.log(
  JSON.stringify({
    status: "PASS",
    schemaReference: "create-scaffold-hbar 0.4.0 TemplateManifestSchema",
    name: manifest.name,
    capabilities: block.capabilities,
    defaults: block.defaults,
  }),
);
