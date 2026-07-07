import { PgBoss } from "pg-boss";
import { syncWarranties, syncTicketResponses } from "../controllers/sync-tickets.controller.js";

export let boss: PgBoss;

export async function startJobs() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL não está definida no ambiente");
  }

  boss = new PgBoss(connectionString);

  boss.on("error", (error: Error) => {
    console.error("Erro no pg-boss:", error);
  });

  await boss.start();

  await boss.createQueue("sync-tickets");

  await boss.work("sync-tickets", async () => {
    const [warranties, ticketResponses] = await Promise.all([
      syncWarranties(),
      syncTicketResponses(),
    ]);

    console.log(
      `Sync concluído — garantias: ${warranties} | tickets: ${ticketResponses.total}`
    );
  });

  await boss.schedule("sync-tickets", "* * * * *", null, {
    singletonKey: "sync-tickets",
  });
}