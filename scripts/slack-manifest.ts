import { slackAppManifest } from "../src/lib/operator/commands";
process.stdout.write(JSON.stringify(slackAppManifest(process.env.AUTH_URL ?? "https://backoffice.vzyx.xyz"),null,2) + "\n");
