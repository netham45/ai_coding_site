import {
  Box,
  Button,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
  Heading,
  Input,
  Stack,
  Text,
  useToast
} from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { UserSettings } from "../api/types";

type SettingsResponse = { settings: UserSettings };

export function SettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [defaultAiCommands, setDefaultAiCommands] = useState<string[]>(["codex --yolo {prompt}"]);

  function updateCommand(index: number, value: string) {
    setDefaultAiCommands((prev) => prev.map((command, rowIndex) => (rowIndex === index ? value : command)));
  }

  function addCommand() {
    setDefaultAiCommands((prev) => [...prev, ""]);
  }

  function removeCommand(index: number) {
    setDefaultAiCommands((prev) => {
      if (prev.length === 1) {
        return [""];
      }
      return prev.filter((_, rowIndex) => rowIndex !== index);
    });
  }

  async function loadData() {
    const settingsRes = await api<SettingsResponse>("/api/users/me/settings");
    setSettings(settingsRes.settings);
    const nextCommands = settingsRes.settings.defaultAiCommands?.length
      ? settingsRes.settings.defaultAiCommands
      : [settingsRes.settings.defaultAiCommand || "codex --yolo {prompt}"];
    setDefaultAiCommands(nextCommands);
  }

  useEffect(() => {
    loadData().catch((error: Error) => {
      toast({ status: "error", title: "Failed to load settings", description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    const normalizedCommands = [...new Set(defaultAiCommands.map((command) => command.trim()).filter((command) => command.length > 0))];
    if (!normalizedCommands.length) {
      toast({ status: "error", title: "At least one AI command is required" });
      return;
    }

    try {
      const result = await api<SettingsResponse>("/api/users/me/settings", {
        method: "PATCH",
        body: JSON.stringify({
          defaultAiCommands: normalizedCommands
        })
      });
      setSettings(result.settings);
      setDefaultAiCommands(result.settings.defaultAiCommands);
      toast({ status: "success", title: "Settings saved" });
    } catch (error: any) {
      toast({ status: "error", title: "Save failed", description: error.message });
    }
  }

  return (
    <Stack spacing={8}>
      <Box bg="white" borderRadius="lg" p={6} boxShadow="sm">
        <Heading size="md" mb={4}>
          User Defaults
        </Heading>
        <form onSubmit={saveSettings}>
          <Grid templateColumns={{ base: "1fr" }} gap={4}>
            <FormControl isRequired>
              <FormLabel>AI Commands</FormLabel>
              <Stack spacing={2}>
                {defaultAiCommands.map((command, index) => (
                  <Flex key={`ai-command-${index}`} gap={2}>
                    <Input value={command} onChange={(e) => updateCommand(index, e.target.value)} />
                    <Button type="button" onClick={() => addCommand()}>
                      +
                    </Button>
                    <Button type="button" onClick={() => removeCommand(index)} isDisabled={defaultAiCommands.length === 1}>
                      -
                    </Button>
                  </Flex>
                ))}
              </Stack>
              <FormHelperText>
                Commands are ordered. The first command is the default used unless a task overrides it.
              </FormHelperText>
            </FormControl>
          </Grid>
          <Button mt={4} colorScheme="teal" type="submit">
            Save Settings
          </Button>
        </form>
        {settings && (
          <Text mt={3} fontSize="sm" color="gray.600">
            Last updated: {new Date(settings.updatedAt).toLocaleString()}
          </Text>
        )}
      </Box>
    </Stack>
  );
}
