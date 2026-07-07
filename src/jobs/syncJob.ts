import { PgBoss } from "pg-boss";
import { syncWarranties, syncTicketResponses } from "../controllers/sync-tickets.controller.js";

export const boss = new PgBoss(process.env.DATABASE_URL!);

export async function startJobs() {
  await boss.start();

  await boss.createQueue("sync-tickets");

  await boss.work("sync-tickets", async () => {
    const [warranties, ticketResponses] = await Promise.all([
      syncWarranties(),
      syncTicketResponses(),
    ]);

    console.log(`Sync concluído  garantias: ${warranties} | tickets: ${ticketResponses.total}`);
  });


  await boss.schedule("sync-tickets", "* * * * *", null, {
    singletonKey: "sync-tickets",
  });
}