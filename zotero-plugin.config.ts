import { defineConfig } from "zotero-plugin-scaffold";

import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    // Keep 0.4.0 in update.json next to the current release: Zotero offers
    // each user the newest entry compatible with their version, so Zotero 7
    // users (0.5.0+ requires Zotero 8) still get 0.4.0 — including anyone
    // updating from 0.3.x. Hash is the published v0.4.0 asset's.
    makeUpdateJson: {
      updates: [
        {
          version: "0.4.0",
          update_link:
            "https://github.com/max3925vats/zotero-docling/releases/download/v0.4.0/zotero-docling.xpi",
          update_hash:
            "sha512:559b919251aa81913b9014ce0141a7a31a4bd6cf8c24abb4fbd4e5ffcced92ee6151e314d9f56618e39a2c0f831e648c837c9f97e31da652b3b335ca2924679b",
          applications: {
            zotero: {
              strict_min_version: "6.999",
              strict_max_version: "10.0.*",
            },
          },
        },
      ],
    },
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        // Zotero 8, 9 and 10 all run on Firefox 140 ESR (0.5.0 dropped Zotero 7).
        target: "firefox140",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
