import "dotenv/config";
import { MoneyManagementV2 } from "./money-management/types";
import { TradeService } from "./database/trade-service";
import { initDatabase } from "./database/schema";
import { MoneyManager } from "./money-management/moneyManager";
import { schedule } from 'node-cron';
import { Candles, ContractStatus, TicksHistoryResponse } from "@deriv/api-types";
import { TelegramManager } from "./telegram";
import apiManager from "./ws";
import { DERIV_TOKEN } from "./utils/constants";
import { TradeWinRateManger } from "./utils/trade-win-rate-manager";
import { calculateCandleTrend, CriteriaSimulation, isTrendUp, runCallPut } from "./backtest/strategies/call-put";

type TSymbol = (typeof symbols)[number];
const symbols = ["R_100"] as const;

const BALANCE_TO_START_TRADING = 1000;
const CONTRACT_SECONDS = 2;

const config: MoneyManagementV2 = {
  type: "fixed",
  initialStake: 1,
  profitPercent: 92,
  maxStake: 600,
  maxLoss: 200,  
  winsBeforeMartingale: 0,
  initialBalance: BALANCE_TO_START_TRADING,
  targetProfit: 500,
};

const tradeConfig = {
  ticksCount: 10, 
}

let isAuthorized = false;
let isTrading = false;
let consecutiveWins = 0;
let lastContractId: number | undefined = undefined;
let lastContractIntervalId: NodeJS.Timeout | null = null;
let tickCount = 0;
let waitingVirtualLoss = false;

let subscriptions: {
  ticks?: any;
  contracts?: any;
} = {};

// Adicionar um array para controlar todas as subscrições ativas
let activeSubscriptions: any[] = [];

// Inicializar o banco de dados
const database = initDatabase();
const tradeService = new TradeService(database);
const tradeWinRateManager = new TradeWinRateManger();
const telegramManager = new TelegramManager(tradeService, tradeWinRateManager);
const moneyManager = new MoneyManager(config, config.initialBalance);

let retryToGetLastTradeCount = 0;

let criteriaArray: CriteriaSimulation[] | undefined = undefined;

// running every 5 minutes - America/Sao_Paulo
const task = schedule('*/10 * * * *', async () => {
  criteriaArray = await runCallPut();
}, {
  scheduled: false,
  timezone: "America/Sao_Paulo"
});

// Configura callback para quando atingir o lucro alvo
moneyManager.setOnTargetReached(async (profit, balance) => {
  const message = `🎯 Lucro alvo atingido!\n\n` +
    `💰 Lucro: $${profit.toFixed(2)}\n` +
    `🎯 Meta: $${config.targetProfit}\n` +
    `💵 Saldo: $${balance.toFixed(2)}\n\n` +
    `✨ Bot será reiniciado automaticamente amanhã às 09:00\n` +
    `🛑 Bot parado com sucesso!`;

  telegramManager.sendMessage(message);
  await stopBot();
  telegramManager.setBotRunning(false);
});

// tradeWinRateManager.setOnTradeReach((type) => {
//   let message = "";

//   if(type === "win") {
//     message = `🎯 **Última Trade**: Ganhou!`;
//   } else {
//     message = `🎯 **Última Trade**: Perdeu!`;
//   }

//   telegramManager.sendMessage(message);
// })

const ticksMap = new Map<TSymbol, number[]>([]);

type TCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number;
}

function formatCandle(candle: Candles[number] & { open_time?: string }) {  
  return {
    time: (candle.open_time || candle.epoch) as unknown as number,
    open: +(candle.open ?? 0),
    high: +(candle.high ?? 0),
    low:  +(candle.low ?? 0),
    close: +(candle.close ?? 0),
  };
}

function convertCandlesToCandles(candles: Candles): TCandle[] {
  return candles.map(formatCandle);
}

const symbolDataMap = new Map<TSymbol, { ticks: number[]; candles: TCandle[]; }>();


function checkPattern(digits: number[]) {
  const lastDigit = digits.at(-1);
  const secondLastDigit = digits.at(-2);
  return secondLastDigit === -9 && lastDigit === -2;
}

function createTradeTimeout() {
  clearTradeTimeout();

  lastContractIntervalId = setInterval(() => {
    if(lastContractId) {
      getLastTradeResult(lastContractId);
    }
  }, ((tradeConfig.ticksCount * CONTRACT_SECONDS) * 1000) * 60);
}

function clearTradeTimeout() {
  if(lastContractIntervalId) {
    clearInterval(lastContractIntervalId);
    lastContractIntervalId = null;
    lastContractId = undefined;
  }
}

function handleTradeResult({
  profit,
  stake,
  status,
  exit_tick_display_value,
  tick_stream,
}: {
  profit: number;
  stake: number;
  status: ContractStatus;
  exit_tick_display_value: string | undefined;
  tick_stream:  {
    epoch?: number;
    tick?: null | number;
    tick_display_value?: null | string;
  }[] | undefined
}) {

  if(status === "open") return;

  updateActivityTimestamp();
  const isWin = status === "won";
  
  // Calcular novo saldo baseado no resultado
  const currentBalance = moneyManager.getCurrentBalance();
  let newBalance = currentBalance;

  isTrading = false;
  lastContractId = undefined;
  // waitingVirtualLoss = !isWin;
  
  if (isWin) {
    newBalance = currentBalance + profit;
    consecutiveWins++;
  } else {
    newBalance = currentBalance - stake;
    consecutiveWins = 0;
  }
  
  // moneyManager.updateBalance(Number(newBalance.toFixed(2)));
  moneyManager.updateLastTrade(isWin);
  telegramManager.updateTradeResult(isWin, moneyManager.getCurrentBalance());

  const resultMessage = isWin ? "✅ Trade ganho!" : "❌ Trade perdido!";
  telegramManager.sendMessage(
    `${resultMessage}\n` +
    `💰 ${isWin ? 'Lucro' : 'Prejuízo'}: $${isWin ? profit : stake}\n` +
    `💵 Saldo: $${moneyManager.getCurrentBalance().toFixed(2)}`
  );  

  // Salvar trade no banco
  tradeService.saveTrade({
    isWin,
    stake,
    profit: isWin ? profit : -stake,
    balanceAfter: newBalance
  }).catch(err => console.error('Erro ao salvar trade:', err));

  clearTradeTimeout();


  tradeWinRateManager.updateTradeResult(isWin);

}

async function getLastTradeResult(contractId: number | undefined) {
  if(!contractId) return;  
  if(retryToGetLastTradeCount >= 2) return;
  try {
    const data = await apiManager.augmentedSend('proposal_open_contract', { contract_id: contractId })
    const contract = data.proposal_open_contract;
    const profit = contract?.profit ?? 0;
    const stake = contract?.buy_price ?? 0;
    const status = contract?.status;
    const exit_tick_display_value = contract?.exit_tick_display_value;
    const tick_stream = contract?.tick_stream;
    retryToGetLastTradeCount = 0;
  
    handleTradeResult({
      profit,
      stake,
      status: status ?? "open",
      exit_tick_display_value,
      tick_stream
    });    

    isTrading = false;
    lastContractId = undefined;
    // waitingVirtualLoss = false;
    tickCount = 0;
  } catch (error: any) {
    console.log("error trying to get last Trade!", error);
    const codeError = error?.error?.code;
    if(codeError && codeError === "AuthorizationRequired") {
      retryToGetLastTradeCount++;
      await authorize()
        .then(() => getLastTradeResult(contractId))
        .catch((err) => console.error("Error trying to login", err))
    }
  }

}

const checkStakeAndBalance = (stake: number) => {
  if (stake < 0.35 || moneyManager.getCurrentBalance() < 0.35) {
    telegramManager.sendMessage(
      "🚨 *ALERTA CRÍTICO*\n\n" +
        "❌ Bot finalizado automaticamente!\n" +
        "💰 Saldo ou stake chegou a zero\n" +
        `💵 Saldo final: $${moneyManager.getCurrentBalance().toFixed(2)}`
    );
    stopBot();
    return false;
  }
  return true;
};

const clearSubscriptions = async () => {
  try {
    // Limpar todas as subscrições ativas
    for (const subscription of activeSubscriptions) {
      if (subscription) {
        try {
          subscription.unsubscribe();
        } catch (error) {
          console.error("Erro ao limpar subscrição:", error);
        }
      }
    }
    
    // Limpar array de subscrições
    activeSubscriptions = [];
    
    // Limpar objeto de subscrições
    subscriptions = {};

    // Resetar todos os estados
    isTrading = false;
    // waitingVirtualLoss = false;
    isAuthorized = false;
    ticksMap.clear();

    console.log("Subscrições limpas. Total agora:", activeSubscriptions.length);

    
  } catch (error) {
    console.error("Erro ao limpar subscrições:", error);
  }
};

const startBot = async () => {
  updateActivityTimestamp(); // Atualizar timestamp ao iniciar o bot
  await clearSubscriptions();

  if (!isAuthorized) {
    await authorize();
  }

  try {
    telegramManager.setBotRunning(true); // Define o estado como rodando ANTES de criar as subscrições
    subscriptions.ticks = subscribeToTicks("R_100");
    subscriptions.contracts = subscribeToOpenOrders();
    
    if (!subscriptions.ticks || !subscriptions.contracts) {
      throw new Error("Falha ao criar subscrições");
    }

    telegramManager.sendMessage("🤖 Bot iniciado e conectado aos serviços Deriv");
  } catch (error) {
    console.error("Erro ao iniciar bot:", error);
    telegramManager.sendMessage("❌ Erro ao iniciar o bot. Tentando parar e limpar as conexões...");
    telegramManager.setBotRunning(false);
    await stopBot();
  }
};

const stopBot = async () => {
  updateActivityTimestamp(); // Atualizar timestamp ao parar o bot
  await clearSubscriptions();
  isTrading = false;
  retryToGetLastTradeCount = 0;
  telegramManager.sendMessage("🛑 Bot parado e desconectado dos serviços Deriv");
};

const subscribeToTicks = (symbol: TSymbol) => {
  console.log("Subscribing to ticks", symbol);

  const ticksStream = apiManager.augmentedSubscribe("ticks_history", {
    ticks_history: symbol,
    granularity: 60,
    count: 30 as unknown as undefined,
    end: 'latest',
    style: 'candles',
    adjust_start_time: 1,
  });

  const subscription = ticksStream.subscribe((data) => {
    updateActivityTimestamp(); // Atualizar timestamp ao receber ticks
    const symbolData = symbolDataMap.get(symbol);

    if (!telegramManager.isRunningBot()) {
      subscription.unsubscribe();
      const index = activeSubscriptions.indexOf(subscription);
      isTrading = false;
      // waitingVirtualLoss = false;
      tickCount = 0;
      if (index > -1) {
        activeSubscriptions.splice(index, 1);
      }
      return;
    }

    if (data.msg_type === "candles") {
      const candles = convertCandlesToCandles(data.candles || []);
      symbolDataMap.set(symbol, {
        candles,
        ticks: []
      });
    }

    if (data.msg_type === 'ohlc') {
      const ohlcData = data as unknown as TicksHistoryResponse['candles'] & {
        ohlc: Candles[number];
      };
      
      const lastPriceTime = symbolDataMap.get(symbol)?.candles.at(-1)?.time;
      const formattedData = formatCandle(ohlcData.ohlc);

      const candles = symbolData?.candles ?? [];
      const ticks = symbolData?.ticks ?? [];

      if(candles.length > 30) candles.shift();

      if(ticks.length > 20) ticks.shift();

      ticks.push(formattedData.close);      

      if (+lastPriceTime! !== +formattedData.time) {
        candles.push(formattedData);
      } else {
        candles.pop();
        candles.push(formattedData);
      }
      
    }

    if (!isAuthorized || !telegramManager.isRunningBot()) return;

    if(isTrading) {
      // tickCount++;
      // if(tickCount >= tradeConfig.ticksCount + 1) {
      //   isTrading = false;
      //   tickCount = 0;
      // }
      return;
    }

    if(criteriaArray) {
      const ticks = symbolData?.ticks ?? [];
      const candles = symbolData?.candles ?? [];
      if(!candles.length || !ticks.length) return;
      const upTrend = isTrendUp(ticks, 11, ticks.length - 1);
      const candleTrend = calculateCandleTrend(candles, 10, 0.004);
      const signal = criteriaArray.find((criteria) => criteria.condition(ticks, ticks.length - 1));

      if (signal) {
        const isPut = signal.type === "PUT";
        const isCall = signal.type === "CALL";
        if(isPut && upTrend) return;
        if(isCall && !upTrend) return;
        if(isCall && candleTrend === "bearish") return;
        if(isPut && candleTrend === "bullish") return;
        if(candleTrend === "sideways") return;
        const candleMicroTrend = calculateCandleTrend(candles, 3, 0.0003);
        if(isPut && candleMicroTrend === "bullish") return;
        if(isCall && candleMicroTrend === "bearish") return;
        
        if (!isTrading) {
          const amount = moneyManager.calculateNextStake();
          if (!checkStakeAndBalance(amount)) {
            stopBot();
            return;
          }

          isTrading = true;
          tickCount = 0;          
        
          apiManager.augmentedSend("buy", {
            buy: "1",
            price: 100,
            parameters: {
              symbol,
              currency: "USD",
              basis: "stake",
              duration: tradeConfig.ticksCount,
              duration_unit: "t",
              amount: Number(amount.toFixed(2)),
              contract_type: signal.type,
            },
          }).then((data) => {
            telegramManager.sendMessage(
              `🎯 Sinal identificado!\n` + 
              `💰 Valor da entrada: $${amount.toFixed(2)} \n` + 
              `⚡ ${signal.type}`
            );
            const contractId = data.buy?.contract_id;
            lastContractId = contractId;
            createTradeTimeout();
          }).catch(err => {
            console.log("BUY CONTRACT ERROR", err);          
          });
        }
      }

    }
    
  }, (err) => {
    console.log("TICKS SUBSCRIPTION ERROR", err);
  });

  activeSubscriptions.push(subscription);
  return ticksStream;
};

const subscribeToOpenOrders = () => {
  const contractSub = apiManager.augmentedSubscribe("proposal_open_contract");
  
  const subscription = contractSub.subscribe((data) => {
    updateActivityTimestamp();

    if (!telegramManager.isRunningBot()) {
      subscription.unsubscribe();
      const index = activeSubscriptions.indexOf(subscription);
      if (index > -1) {
        activeSubscriptions.splice(index, 1);
      }
      return;
    }

    const contract = data.proposal_open_contract;
    const status = contract?.status;
    const profit = contract?.profit ?? 0;
    const stake = contract?.buy_price || 0;
    const exit_tick_display_value = contract?.exit_tick_display_value;
    const tick_stream = contract?.tick_stream;

    handleTradeResult({
      profit,
      stake,
      status: status ?? "open",
      exit_tick_display_value,
      tick_stream
    });

  },(err) => {
    console.log("CONTRACT SUBSCRIPTION ERROR", err);    
  });

  activeSubscriptions.push(subscription);
  return contractSub;
};

const authorize = async () => {
  try {
    await apiManager.authorize(DERIV_TOKEN);
    isAuthorized = true;
    telegramManager.sendMessage("🔐 Bot autorizado com sucesso na Deriv");
    return true;
  } catch (err) {
    isAuthorized = false;
    telegramManager.sendMessage("❌ Erro ao autorizar bot na Deriv");
    return false;
  }
};

// Adicionar verificação periódica do estado do bot
setInterval(async () => {
  if (telegramManager.isRunningBot() && !waitingVirtualLoss && moneyManager.getCurrentBalance() > 0) {
    // Verificar se o bot está "travado"
    const lastActivity = Date.now() - lastActivityTimestamp;
    if (lastActivity > (60_000 * 40)) { // 40 minutos sem atividade
      console.log("Detectado possível travamento do bot, resetando estados...");
      isTrading = false;
      // waitingVirtualLoss = false;
      lastActivityTimestamp = Date.now();
      await clearSubscriptions();
    }
  }
}, (30_000)); // 30 seconds

// Adicionar timestamp da última atividade
let lastActivityTimestamp = Date.now();

// Atualizar o timestamp em momentos importantes
const updateActivityTimestamp = () => {
  lastActivityTimestamp = Date.now();
};


async function main() {
  task.start();

  apiManager.connection.addEventListener("open", async () => {
    telegramManager.sendMessage("🌐 Conexão WebSocket estabelecida");
    authorize();
  });

  apiManager.connection.addEventListener("close", async () => {
    isAuthorized = false;
    await clearSubscriptions();
    telegramManager.sendMessage("⚠️ Conexão WebSocket fechada");
  });

  apiManager.connection.addEventListener("error", async (event) => {
    console.error("Erro na conexão:", event);
    telegramManager.sendMessage("❌ Erro na conexão com o servidor Deriv");
    await clearSubscriptions();
  });

  // Observadores do estado do bot do Telegram
  setInterval(async () => {
    // Se o bot está marcado como rodando mas não tem subscrições, tenta reconectar
    if (telegramManager.isRunningBot() && !subscriptions.ticks) {
      console.log("Tentando reconectar bot...");
      await clearSubscriptions();
      await startBot();
    } 
    // Se o bot não está marcado como rodando MAS tem subscrições ativas, limpa as subscrições
    else if (!telegramManager.isRunningBot() && (subscriptions.ticks || subscriptions.contracts)) {
      console.log("Limpando subscrições pendentes...");      
      await clearSubscriptions();
    }
  }, 10_000);

  criteriaArray = await runCallPut();
}

main();
