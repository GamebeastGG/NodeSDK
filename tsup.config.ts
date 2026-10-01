import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    client: "src/client/index.ts",
    server: "src/server/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // ES2020 keeps the output loadable by every evergreen browser and Node >= 20 without a
  // downstream transpile step.
  target: "es2020",
  // Shared internals are bundled into each entry rather than emitted as a shared chunk, so the
  // browser build never pulls in server-only code and vice versa.
  splitting: false,
  treeshake: true,
});
