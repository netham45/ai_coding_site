import { extendTheme } from "@chakra-ui/react";

export const appTheme = extendTheme({
  fonts: {
    heading: "'Space Grotesk', sans-serif",
    body: "'IBM Plex Sans', sans-serif"
  },
  colors: {
    brand: {
      50: "#e8f5f2",
      100: "#c6e6df",
      200: "#a1d5ca",
      300: "#7ac4b5",
      400: "#58b4a2",
      500: "#3f9a88",
      600: "#31786b",
      700: "#24574e",
      800: "#163732",
      900: "#091915"
    }
  },
  styles: {
    global: {
      body: {
        bg: "#f7f8f7",
        color: "#15211d"
      }
    }
  }
});
