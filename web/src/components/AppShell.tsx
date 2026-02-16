import { Box, Flex, HStack, Link, Text } from "@chakra-ui/react";
import { NavLink } from "react-router-dom";
import type { PropsWithChildren } from "react";

function TopNavLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      as={NavLink}
      to={to}
      px={3}
      py={2}
      borderRadius="md"
      _activeLink={{ bg: "brand.600", color: "white" }}
      _hover={{ textDecoration: "none", bg: "brand.100" }}
    >
      {label}
    </Link>
  );
}

export function AppShell({ children }: PropsWithChildren) {
  return (
    <Box minH="100vh" bgGradient="linear(to-b, #f7f8f7, #eef3f1)">
      <Box borderBottom="1px solid" borderColor="blackAlpha.200" bg="whiteAlpha.900" backdropFilter="blur(8px)">
        <Box px={{ base: 4, md: 6, xl: 8 }} py={4}>
          <Flex align="center" justify="space-between" gap={4}>
            <Text fontWeight="700" letterSpacing="0.02em">
              AI Coding Web View
            </Text>
            <HStack spacing={2}>
              <TopNavLink to="/" label="Projects" />
              <TopNavLink to="/settings" label="Settings" />
            </HStack>
          </Flex>
        </Box>
      </Box>
      <Box px={{ base: 4, md: 6, xl: 8 }} py={6}>
        {children}
      </Box>
    </Box>
  );
}
