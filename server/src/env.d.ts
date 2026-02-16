declare namespace NodeJS {
  interface ProcessEnv {
    PORT?: string;
    HOST?: string;
    TERMINAL_TOKEN_SECRET?: string;
    TERMINAL_TOKEN_TTL_SECONDS?: string;
  }
}
