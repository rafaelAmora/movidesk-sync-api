import express from "express";
import { startJobs } from "./jobs/syncJob.js";
import router from "./routes/index.js";
import "dotenv/config";
import { errorHadling } from "./middlewares/errorHandling.js";
import { seedAdmin } from "./utils/seedAdmin.js";
import cors from "cors";

const app = express();

app.use(
  cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());
app.use(router);
app.use(errorHadling);

async function bootstrap() {
  await seedAdmin();
  await startJobs();

  app.listen(process.env.PORT ?? 3000, () => {
    console.log(`Servidor rodando na porta ${process.env.PORT ?? 3000}`);
  });
}

bootstrap().catch((error) => {
  console.error("Falha ao iniciar a aplicação:", error);
  process.exit(1);
});
