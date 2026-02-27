export const REFERENCE_DOCS: Record<string, string> = {
  diagrams: `# Diagram Syntax Reference
Create interactive diagrams in notes using \`\`\`diagram code blocks with JSON inside.

## Basic Structure
\\\`\\\`\\\`diagram
{
  "id": "unique-id",
  "type": "diagram",
  "version": 1,
  "grammar": "architecture",
  "model": {
    "nodes": [
      {"id": "client", "label": "Client", "kind": "actor"},
      {"id": "api", "label": "API", "kind": "service"}
    ],
    "edges": [
      {"id": "e1", "from": "client", "to": "api", "label": "HTTP"}
    ]
  },
  "baseView": {
    "layout": {"type": "layered", "direction": "LR"}
  }
}
\\\`\\\`\\\`

## Grammars
- architecture — System architecture, services, components
- flowchart — Process flows, decision trees
- state_machine — State transitions
- sequence — Interaction sequences
- data_flow — Data pipelines
- network — Network topology
- timeline — Events over time
- dependency_graph — Dependencies

## Layouts
- layered (PREFERRED) — direction: "TB" or "LR"
- force — Physics-based, for cyclic graphs
`,

  "ws-blocks": `# WS-Block Syntax Reference
WS-blocks are structured JSON content blocks embedded in notes.

## Types
- reference — Link to code in the codebase
- cli — Executable command block
- patch — Applyable code diff
- agent_action — Triggerable agent task

## Format
\\\`\\\`\\\`ws-block:{type}
{
  "id": "uuid",
  "version": 1,
  "type": "{type}",
  "createdAt": "ISO-date",
  "createdBy": "agent",
  ...type-specific fields
}
\\\`\\\`\\\`
`,

  tasks: `# Task Syntax Reference
Use @@@task blocks to define tasks in notes.

## Format
@@@task
# Task Title
Description of what the task achieves.

## Scope
What files/areas are in scope.

## Definition of Done
Specific completion criteria.

## Verification
Commands to verify completion.
@@@

Tasks auto-convert to Task Notes when the note is saved.
`,
};
