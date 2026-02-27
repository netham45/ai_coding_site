import { AddIcon, DeleteIcon } from "@chakra-ui/icons";
import { Badge, Box, Button, Flex, FormControl, FormLabel, Input, Select, Stack, Text } from "@chakra-ui/react";
import type { NodeDependencyRef, NodeTier, TaskStatus } from "../api/types";

export type DependencyPickerCandidate = {
  id: string;
  title: string;
  tier: NodeTier;
  status: TaskStatus;
  isBlocked: boolean;
  unresolvedDependencyCount?: number;
};

type NodeDependencyPickerProps = {
  label?: string;
  value: NodeDependencyRef[];
  candidates: DependencyPickerCandidate[];
  selfNodeId?: string;
  onChange: (next: NodeDependencyRef[]) => void;
  helperText?: string;
};

const TIER_OPTIONS: NodeTier[] = ["epoch", "phase", "plan", "task", "exec"];

function normalizeRefs(refs: NodeDependencyRef[], candidatesById: Map<string, DependencyPickerCandidate>, selfNodeId?: string): NodeDependencyRef[] {
  const deduped: NodeDependencyRef[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const id = ref.id.trim();
    if (!id) {
      deduped.push({
        id: "",
        tier: ref.tier,
        reason: ref.reason
      });
      continue;
    }
    if (selfNodeId && id === selfNodeId) continue;
    const fallbackTier = candidatesById.get(id)?.tier;
    const tier = ref.tier ?? fallbackTier ?? "task";
    const key = `${id}:${tier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      id,
      tier,
      reason: ref.reason?.trim() || undefined
    });
  }

  return deduped;
}

function statusColor(status: TaskStatus) {
  if (status === "queued") return "gray";
  if (status === "in_progress") return "blue";
  if (status === "merge_ready" || status === "merged") return "green";
  if (status === "failed" || status === "cancelled" || status === "merge_conflict") return "red";
  return "purple";
}

export function NodeDependencyPicker(props: NodeDependencyPickerProps) {
  const { label = "Dependencies", value, candidates, selfNodeId, onChange, helperText } = props;
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const rows = value.length ? value : [{ id: "", tier: undefined, reason: "" }];

  function updateRows(nextRows: NodeDependencyRef[]) {
    const normalized = normalizeRefs(nextRows, candidatesById, selfNodeId);
    onChange(normalized);
  }

  return (
    <FormControl>
      <FormLabel>{label}</FormLabel>
      <Stack spacing={2}>
        {rows.map((row, index) => {
          const candidate = row.id ? candidatesById.get(row.id) : undefined;
          const selectedTier = row.tier ?? candidate?.tier ?? "task";
          const selectedElsewhere = new Set(
            rows
              .map((item, idx) => (idx === index ? null : item.id))
              .filter((id): id is string => Boolean(id))
          );
          return (
            <Stack key={`dep-row-${index}`} spacing={2} border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={2}>
              <Flex gap={2} direction={{ base: "column", md: "row" }}>
                <Select
                  placeholder="Select upstream node"
                  value={row.id}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const nextRows = rows.map((item, rowIndex) =>
                      rowIndex === index
                        ? {
                            id: nextId,
                            tier: nextId ? candidatesById.get(nextId)?.tier ?? item.tier : undefined,
                            reason: item.reason
                          }
                        : item
                    );
                    updateRows(nextRows);
                  }}
                >
                  {candidates.map((option) => {
                    const unresolved = option.unresolvedDependencyCount ?? 0;
                    const descriptor = [
                      option.isBlocked ? "blocked" : option.status,
                      unresolved > 0 ? `unresolved:${unresolved}` : null
                    ]
                      .filter(Boolean)
                      .join(", ");
                    return (
                      <option key={option.id} value={option.id} disabled={selectedElsewhere.has(option.id)}>
                        [{option.tier}] {option.title} ({descriptor})
                      </option>
                    );
                  })}
                </Select>
                <Select
                  value={selectedTier}
                  onChange={(event) => {
                    const nextTier = event.target.value as NodeTier;
                    const nextRows = rows.map((item, rowIndex) => (rowIndex === index ? { ...item, tier: nextTier } : item));
                    updateRows(nextRows);
                  }}
                >
                  {TIER_OPTIONS.map((tier) => (
                    <option key={tier} value={tier}>
                      {tier}
                    </option>
                  ))}
                </Select>
              </Flex>
              <Input
                placeholder="Reason (optional)"
                value={row.reason ?? ""}
                onChange={(event) => {
                  const nextReason = event.target.value;
                  const nextRows = rows.map((item, rowIndex) => (rowIndex === index ? { ...item, reason: nextReason } : item));
                  updateRows(nextRows);
                }}
              />
              {!!candidate && (
                <Flex gap={2} wrap="wrap">
                  <Badge colorScheme={statusColor(candidate.status)}>{candidate.status}</Badge>
                  {candidate.isBlocked ? <Badge colorScheme="orange">blocked</Badge> : null}
                  {(candidate.unresolvedDependencyCount ?? 0) > 0 ? (
                    <Badge colorScheme="red">unresolved upstream refs: {candidate.unresolvedDependencyCount}</Badge>
                  ) : null}
                </Flex>
              )}
              <Flex gap={2} justify="flex-end">
                <Button
                  type="button"
                  size="sm"
                  leftIcon={<AddIcon />}
                  onClick={() => {
                    updateRows([...rows, { id: "", tier: undefined, reason: "" }]);
                  }}
                >
                  Add
                </Button>
                <Button
                  type="button"
                  size="sm"
                  leftIcon={<DeleteIcon />}
                  isDisabled={rows.length === 1}
                  onClick={() => {
                    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
                    updateRows(nextRows.length ? nextRows : [{ id: "", tier: undefined, reason: "" }]);
                  }}
                >
                  Remove
                </Button>
              </Flex>
            </Stack>
          );
        })}
      </Stack>
      <Box mt={1}>
        <Text fontSize="sm" color="gray.600">
          {helperText ?? "Dependencies can reference any node tier. Duplicate node+tier refs are automatically removed."}
        </Text>
        {selfNodeId ? (
          <Text fontSize="sm" color="gray.600">
            Self-dependencies are not allowed.
          </Text>
        ) : null}
      </Box>
    </FormControl>
  );
}
