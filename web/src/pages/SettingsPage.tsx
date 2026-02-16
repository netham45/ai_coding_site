import {
  Box,
  Button,
  FormControl,
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
  const [defaultAiCommand, setDefaultAiCommand] = useState("codex --yolo {prompt}");

  async function loadData() {
    const settingsRes = await api<SettingsResponse>("/api/users/me/settings");
    setSettings(settingsRes.settings);
    setDefaultAiCommand(settingsRes.settings.defaultAiCommand || "codex --yolo {prompt}");
  }

  useEffect(() => {
    loadData().catch((error: Error) => {
      toast({ status: "error", title: "Failed to load settings", description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    try {
      const result = await api<SettingsResponse>("/api/users/me/settings", {
        method: "PATCH",
        body: JSON.stringify({
          defaultAiCommand
        })
      });
      setSettings(result.settings);
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
              <FormLabel>Default AI Command</FormLabel>
              <Input value={defaultAiCommand} onChange={(e) => setDefaultAiCommand(e.target.value)} />
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
