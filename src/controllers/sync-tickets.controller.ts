import type { Request, Response } from "express";
import { api } from "../api/MovideskAPI.js";
import type { MovideskTicket } from "../types/MovideskTicket.js";
import { prisma } from "../client/prisma.js";

const CHUNK_SIZE = 10;

function ticketBy(origin: number) {
  switch (origin) {
    case 1:
      return "EMAIL";
    case 9:
      return "BOT";
    case 2:
      return "DISTRIBUTOR";
    default:
      return "AGENT";
  }
}

const getFieldValue = (ticket: MovideskTicket, fieldId: number) =>
  ticket.customFieldValues?.find((f) => f.customFieldId === fieldId)?.value ??
  null;

const getFieldValueItem = (ticket: MovideskTicket, fieldId: number) =>
  ticket.customFieldValues?.find((f) => f.customFieldId === fieldId)?.items?.[0]
    ?.customFieldItem ?? null;

function buildWarrantyFilter(): string {
  const year = new Date().getFullYear();

  const warrantyCategoryOrFields =
    `(` +
    `category eq 'Garantia'` +
    ` or category eq 'Fora da Garantia'` +
    ` or customFieldValues/any(cf: cf/customFieldId eq 107733 and cf/value ne null)` +
    ` or customFieldValues/any(cf: cf/customFieldId eq 243250 and cf/value ne null)` +
    `)`;

  return (
    `${warrantyCategoryOrFields}` +
    ` and lastUpdate ge ${year}-01-01T00:00:00Z` +
    ` and lastUpdate le ${year}-12-31T23:59:59Z`
  );
}

function normalizeWarrantyCategory(
  rawCategory: string | null,
  warrantyApprovedAt: string | null,
  warrantyDeniedAt: string | null,
): string | null {
  if (rawCategory === "Garantia" || rawCategory === "Fora da Garantia") {
    return rawCategory;
  }
  if (warrantyApprovedAt) return "Garantia";
  if (warrantyDeniedAt) return "Fora da Garantia";
  return rawCategory;
}

async function upsertWarrantyChunks(
  tickets: MovideskTicket[],
): Promise<number> {
  const valid = tickets.filter((ticket) => {
    const serialNumber = getFieldValue(ticket, 92408);
    return serialNumber && serialNumber !== "XXXXXXXXXX";
  });

  let saved = 0;

  for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
    const chunk = valid.slice(i, i + CHUNK_SIZE);

    const results = await Promise.allSettled(
      chunk.map((ticket) => {
        const serialNumber = getFieldValue(ticket, 92408)!;
        const warrantyApprovedAt = getFieldValue(ticket, 107733);
        const warrantyDeniedAt = getFieldValue(ticket, 243250);
        const category = normalizeWarrantyCategory(
          ticket.category ?? null,
          warrantyApprovedAt,
          warrantyDeniedAt,
        );
        const approvalIssueReason = getFieldValueItem(ticket, 224262);
        const isRecurrentInAnalysis = getFieldValueItem(ticket, 216435);
        const defect = getFieldValueItem(ticket, 144016);
        const model = getFieldValueItem(ticket, 152179); // <-- novo

        return prisma.warrantyTickets.upsert({
          where: { ticket: ticket.id },
          update: {
            serialNumber,
            category,
            approvalIssueReason,
            isRecurrentInAnalysis,
            defect,
            model,
            team: ticket.ownerTeam,
            warrantyApprovedAt: warrantyApprovedAt
              ? new Date(warrantyApprovedAt)
              : null,
            warrantyDeniedAt: warrantyDeniedAt
              ? new Date(warrantyDeniedAt)
              : null,
          },
          create: {
            ticket: ticket.id,
            serialNumber,
            approvalIssueReason,
            isRecurrentInAnalysis,
            defect,
            model, 
            category,
            team: ticket.ownerTeam,
            warrantyApprovedAt: warrantyApprovedAt
              ? new Date(warrantyApprovedAt)
              : null,
            warrantyDeniedAt: warrantyDeniedAt
              ? new Date(warrantyDeniedAt)
              : null,
          },
        });
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") saved++;
    }
  }

  return saved;
}

async function syncWarranties(): Promise<number> {
  const PAGE_SIZE = 400;
  let skip = 0;
  let total = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await api.get<MovideskTicket[]>("/tickets", {
      params: {
        token: process.env.MOVIDESK_TOKEN,
        $select: "id,status,createdDate,category,customFieldValues,origin",
        $expand: "customFieldValues($expand=items)",
        $filter: buildWarrantyFilter(),
        $orderby: "id asc",
        $top: PAGE_SIZE,
        $skip: skip,
      },
    });

    const tickets: MovideskTicket[] = response.data;

    if (!Array.isArray(tickets) || tickets.length === 0) break;

    total += await upsertWarrantyChunks(tickets);

    if (tickets.length < PAGE_SIZE) hasMore = false;
    else skip += PAGE_SIZE;
  }

  return total;
}

function buildTicketFilter(): string {
  return (
    `(` +
    `(` +
    `justification eq 'Aguardando Retorno da Growatt'` +
    ` and (ownerTeam eq 'Equipe Inversor' or ownerTeam eq 'Equipe Monitoramento')` +
    `)` +
    ` or (` +
    `justification eq 'Aguardando Retorno da Growatt'` +
    ` and serviceFirstLevel eq '2.1 - E-mail'` +
    `)` +
    `  or status eq 'Novo'  )`
  );
}

function wasLastActionFromCustomer(ticket: MovideskTicket): boolean {
  if (!ticket.actions || ticket.actions.length === 0) {
    return false;
  }
  const lastAction = ticket.actions[ticket.actions.length - 1];
  return lastAction?.createdBy?.profileType === 2;
}

function wasLastActionWithin7Days(ticket: MovideskTicket): boolean {
  if (!ticket.actions || ticket.actions.length === 0) {
    return false;
  }
  const lastAction = ticket.actions[ticket.actions.length - 1];
  const lastActionDate = new Date(lastAction!.createdDate);
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  return lastActionDate >= sevenDaysAgo;
}

function ticketHasOwner(ticket: MovideskTicket): boolean {
  if (ticket.owner && typeof ticket.owner === "object" && ticket.owner.id) {
    return true;
  }

  if (ticket.ownerHistories && ticket.ownerHistories.length > 0) {
    const lastHistory = ticket.ownerHistories[ticket.ownerHistories.length - 1];
    if (
      lastHistory?.owner &&
      typeof lastHistory?.owner === "object" &&
      lastHistory.owner.id
    ) {
      return true;
    }
  }

  return false;
}

function getOwnerTeam(ticket: MovideskTicket): string | null {
  if (ticket.ownerTeam) {
    return ticket.ownerTeam;
  }
  if (ticket.serviceFirstLevel === "2.1 - E-mail" || ticket.status === "Novo") {
    return "Email";
  }
  return null;
}

function getTicketCategory(ticket: MovideskTicket): string {
  if (
    ticket.category === "Garantia" ||
    ticket.category === "Fora da Garantia"
  ) {
    return "GARANTIA";
  }

  const isInversor =
    ticket.ownerTeam === "Equipe Inversor" &&
    ticket.justification === "Aguardando Retorno da Growatt";
  const isMonitoramento =
    ticket.ownerTeam === "Equipe Monitoramento" &&
    ticket.justification === "Aguardando Retorno da Growatt";
  const isEmail =
    ticket.justification === "Aguardando Retorno da Growatt" &&
    ticket.serviceFirstLevel === "2.1 - E-mail";
  const isNew = ticket.status === "Novo";

  if (isInversor) return "INVERSOR";
  if (isMonitoramento) return "MONITORAMENTO";
  if (isEmail) return "EMAIL";
  if (isNew) return "NOVO";
  return "OUTRO";
}

function shouldIncludeTicket(ticket: MovideskTicket): {
  include: boolean;
  category: string;
  reason?: string;
} {
  // Ignorar garantia
  if (
    ticket.category === "Garantia" ||
    ticket.category === "Fora da Garantia"
  ) {
    return {
      include: false,
      category: "GARANTIA",
      reason: "Ticket de garantia - ignorado",
    };
  }

  const isInversor =
    ticket.ownerTeam === "Equipe Inversor" &&
    ticket.justification === "Aguardando Retorno da Growatt";
  const isMonitoramento =
    ticket.ownerTeam === "Equipe Monitoramento" &&
    ticket.justification === "Aguardando Retorno da Growatt";

  if (isInversor) {
    return { include: true, category: "INVERSOR" };
  }
  if (isMonitoramento) {
    return { include: true, category: "MONITORAMENTO" };
  }

  const isEmail =
    ticket.justification === "Aguardando Retorno da Growatt" &&
    ticket.serviceFirstLevel === "2.1 - E-mail";
  const isNew = ticket.status === "Novo";

  // 2. EMAIL: aplica regras
  if (isEmail) {
    const isFromCustomer = wasLastActionFromCustomer(ticket);
    const hasNoOwner = !ticketHasOwner(ticket);
    const isWithin7Days = wasLastActionWithin7Days(ticket);

    if (!isFromCustomer) {
      return {
        include: false,
        category: "EMAIL",
        reason: "Última ação não é do cliente",
      };
    }
    if (!hasNoOwner) {
      return {
        include: false,
        category: "EMAIL",
        reason: "Ticket tem responsável atribuído",
      };
    }
    if (!isWithin7Days) {
      return {
        include: false,
        category: "EMAIL",
        reason: "Última ação tem mais de 7 dias",
      };
    }
    return { include: true, category: "EMAIL" };
  }

  if (isNew) {
    const isFromCustomer = wasLastActionFromCustomer(ticket);
    const hasNoOwner = !ticketHasOwner(ticket);
    const isWithin7Days = wasLastActionWithin7Days(ticket);

    if (!isFromCustomer) {
      return {
        include: false,
        category: "NOVO",
        reason: "Última ação não é do cliente",
      };
    }
    if (!hasNoOwner) {
      return {
        include: false,
        category: "NOVO",
        reason: "Ticket tem responsável atribuído",
      };
    }
    if (!isWithin7Days) {
      return {
        include: false,
        category: "NOVO",
        reason: "Última ação tem mais de 7 dias",
      };
    }
    return { include: true, category: "NOVO" };
  }

  return {
    include: false,
    category: "OUTRO",
    reason: "Não atende a nenhuma categoria",
  };
}

// FUNÇÕES DE BANCO E SINCRONIZAÇÃO

async function upsertTicketChunks(tickets: MovideskTicket[]): Promise<number> {
  let processed = 0;

  for (let i = 0; i < tickets.length; i += CHUNK_SIZE) {
    const chunk = tickets.slice(i, i + CHUNK_SIZE);

    const results = await Promise.allSettled(
      chunk.map((ticket) => {
        const team = getOwnerTeam(ticket);

        return prisma.ticketResponse.upsert({
          where: { ticketId: String(ticket.id) },
          update: {
            title: ticket.subject ?? null,
            category: ticket.category ?? null,
            status: ticket.status,
            team: team,
            openedAt: new Date(ticket.createdDate),
          },
          create: {
            ticketId: String(ticket.id),
            title: ticket.subject ?? null,
            category: ticket.category ?? null,
            status: ticket.status,
            team: team,
            channel: ticketBy(ticket.origin),
            openedAt: new Date(ticket.createdDate),
          },
        });
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") processed++;
    }
  }

  return processed;
}

async function syncTicketResponses(): Promise<{ total: number; stats: any }> {
  const PAGE_SIZE = 400;
  let skip = 0;
  let totalProcessed = 0;
  let hasMore = true;
  const idsAtuais = new Set<string>();

  const stats = {
    total: {
      inversor: 0,
      monitoramento: 0,
      email: 0,
      novo: 0,
      garantia: 0,
      outro: 0,
    },
    salvos: { inversor: 0, monitoramento: 0, email: 0, novo: 0 },
    filtrados: {
      inversor: { total: 0, salvos: 0 },
      monitoramento: { total: 0, salvos: 0 },
      email: {
        total: 0,
        salvos: 0,
        falhouCliente: 0,
        falhouOwner: 0,
        falhou7Dias: 0,
      },
      novo: {
        total: 0,
        salvos: 0,
        falhouCliente: 0,
        falhouOwner: 0,
        falhou7Dias: 0,
      },
      garantia: { total: 0 },
      outro: { total: 0 },
    },
  };

  while (hasMore) {
    const response = await api.get<MovideskTicket[]>("/tickets", {
      params: {
        token: process.env.MOVIDESK_TOKEN,
        $select:
          "id,subject,status,justification,category,createdDate,origin,ownerTeam,owner,actions,serviceFirstLevel,ownerHistories,createdBy",
        $expand:
          "actions($expand=createdBy),ownerHistories($expand=owner),owner",
        $filter: buildTicketFilter(),
        $orderby: "id asc",
        $top: PAGE_SIZE,
        $skip: skip,
      },
    });

    const tickets: MovideskTicket[] = response.data;

    if (!Array.isArray(tickets) || tickets.length === 0) break;

    // Contagem total por categoria
    for (const ticket of tickets) {
      const category = getTicketCategory(ticket);
      if (category === "INVERSOR") stats.total.inversor++;
      else if (category === "MONITORAMENTO") stats.total.monitoramento++;
      else if (category === "EMAIL") stats.total.email++;
      else if (category === "NOVO") stats.total.novo++;
      else if (category === "GARANTIA") stats.total.garantia++;
      else stats.total.outro++;
    }

    // Aplica filtros
    const results = tickets.map((ticket) => {
      const result = shouldIncludeTicket(ticket);

      if (result.category === "INVERSOR") stats.filtrados.inversor.total++;
      else if (result.category === "MONITORAMENTO")
        stats.filtrados.monitoramento.total++;
      else if (result.category === "EMAIL") stats.filtrados.email.total++;
      else if (result.category === "NOVO") stats.filtrados.novo.total++;
      else if (result.category === "GARANTIA") stats.filtrados.garantia.total++;
      else if (result.category === "OUTRO") stats.filtrados.outro.total++;

      if (
        !result.include &&
        (result.category === "EMAIL" || result.category === "NOVO")
      ) {
        const target =
          result.category === "EMAIL"
            ? stats.filtrados.email
            : stats.filtrados.novo;
        if (result.reason?.includes("cliente")) target.falhouCliente++;
        else if (result.reason?.includes("responsável")) target.falhouOwner++;
        else if (result.reason?.includes("7 dias")) target.falhou7Dias++;
      }

      return { ticket, ...result };
    });

    const filteredTickets = results
      .filter((r) => r.include)
      .map((r) => r.ticket);

    // Conta salvos por categoria
    for (const ticket of filteredTickets) {
      const category = getTicketCategory(ticket);
      if (category === "INVERSOR") stats.salvos.inversor++;
      else if (category === "MONITORAMENTO") stats.salvos.monitoramento++;
      else if (category === "EMAIL") stats.salvos.email++;
      else if (category === "NOVO") stats.salvos.novo++;
    }

    for (const ticket of filteredTickets) {
      idsAtuais.add(String(ticket.id));
    }

    totalProcessed += await upsertTicketChunks(filteredTickets);

    if (tickets.length < PAGE_SIZE) hasMore = false;
    else skip += PAGE_SIZE;
  }

  if (idsAtuais.size > 0) {
    await prisma.ticketResponse.deleteMany({
      where: {
        ticketId: { notIn: Array.from(idsAtuais) },
      },
    });
  } else {
    console.warn(
      "[syncTicketResponses] idsAtuais vazio — deleteMany ignorado para evitar perda de dados.",
    );
  }

  return { total: totalProcessed, stats };
}

class SyncTicketsController {
  async sync(req: Request, res: Response) {
    try {
      const startTime = Date.now();

      const [warranties, ticketResult] = await Promise.all([
        syncWarranties(),
        syncTicketResponses(),
      ]);

      const { total, stats } = ticketResult;

      const totalSalvoGeral =
        stats.salvos.inversor +
        stats.salvos.monitoramento +
        stats.salvos.email +
        stats.salvos.novo;

      console.log(
        `[Sync] ticketResponse: ${totalSalvoGeral} salvos | warrantyTickets: ${warranties} salvos (${(Date.now() - startTime) / 1000}s)`,
      );

      return res.json({
        message: "Sync concluído",
        warranties,
        tickets: total,
        stats: {
          total: stats.total,
          salvos: stats.salvos,
          filtrados: stats.filtrados,
          tempo_execucao: `${(Date.now() - startTime) / 1000}s`,
        },
      });
    } catch (error) {
      console.error("Erro na sincronização:", error);
      return res.status(500).json({
        message: "Erro ao sincronizar",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export { SyncTicketsController, syncWarranties, syncTicketResponses };
