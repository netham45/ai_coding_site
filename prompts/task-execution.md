# Task Execution Template

Use this template for execution-tier coordinator instructions.

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Execution-Specific Requirements

- Keep goals scoped to current task node.
- Identify upstream deps that block execution.
- Emit bounded-iteration instructions for retry/replan behavior.
- Emit artifact evidence references that prove DoD completion.

## Output

- Natural-language rationale
- Structured payload per prompt contract
- Execution instruction summary
