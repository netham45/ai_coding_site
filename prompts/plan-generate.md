# Plan Generate Template

Use this template for generating plan-level outputs (`tasks:` list and orchestration metadata).

## Include Shared Section

Include `prompts/shared-input-output.md`.

## Plan-Specific Requirements

- Emit planner tasks compatible with extraction and approval.
- Provide stable item ids for dependency wiring.
- Include explicit dependency reasons in structured payload.
- Include automation guidance for sub-plans and execution items.

## Output

- Natural-language rationale
- Structured payload per prompt contract
- YAML plan body for parser compatibility
