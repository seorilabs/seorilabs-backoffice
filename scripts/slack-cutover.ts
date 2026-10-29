import { cutoverSlackNotifications } from "../src/lib/notifications/slack-cutover";
import { prisma } from "../src/lib/prisma";

cutoverSlackNotifications(process.argv.includes("--apply"))
  .then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error instanceof Error ? error.message : "Slack 전환 실패");process.exitCode=1;})
  .finally(()=>prisma.$disconnect());
