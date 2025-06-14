import { loadHistoricalData } from "../../utils/load-data";

type TradeType = "CALL" | "PUT";

// Tipo para o critério
export interface CriteriaSimulation {
  name: string;
  type: TradeType;
  parameters: Record<string, number>;
  minWindow: number;
  condition: (ticks: number[], i: number) => boolean;
}

interface SimulationResult {
  criteria: string;
  parameters: Record<string, number>;
  winRate: number;
  totalEntries: number;
  criteriaObj: CriteriaSimulation;
}

function findBestCriteria(
  ticks: number[],
  contractDuration: number
): SimulationResult[] {
  const criteriaArr: CriteriaSimulation[] = generateCriteria();
  const results: SimulationResult[] = [];

  for (const criteria of criteriaArr) {
    let wins = 0;
    let total = 0;

    for (let i = 0; i < ticks.length - contractDuration; i++) {
      if (criteria.condition(ticks, i)) {
        total++;
        const entryPrice = ticks[i];
        const exitPrice = ticks[i + contractDuration];
        if (criteria.type === "CALL" && exitPrice > entryPrice) wins++;
        if (criteria.type === "PUT" && exitPrice < entryPrice) wins++;
      }
    }

    results.push({
      criteria: criteria.name,
      parameters: criteria.parameters,
      winRate: total > 0 ? wins / total : 0,
      totalEntries: total,
      criteriaObj: criteria,
    });
  }

  // Ordena pelo melhor winRate
  return results.sort((a, b) => b.winRate - a.winRate);
}

// Função para detectar tendência
function detectTrend(ticks: number[], period: number, i: number): { direction: 'ALTA' | 'BAIXA' | 'LATERAL', force: number } {
  if (i < period) return { direction: 'LATERAL', force: 0 };
  
  const window = ticks.slice(i - period + 1, i + 1);
  // const media = janela.reduce((a, b) => a + b, 0) / periodo;
  const currentPrice = ticks[i];
  
  // Calcula a inclinação da tendência
  const inclination = (currentPrice - window[0]) / window[0];
  
  // Calcula a volatilidade
  const max = Math.max(...window);
  const min = Math.min(...window);
  const volatility = (max - min) / min;
  
  // Determina a direção e força da tendência
  if (Math.abs(inclination) < 0.001) {
    return { direction: 'LATERAL', force: 0 };
  }
  
  const direction = inclination > 0 ? 'ALTA' : 'BAIXA';
  const force = Math.abs(inclination) / volatility;
  
  return { direction, force };
}

// Função para calcular o momentum
function calculateMomentum(ticks: number[], period: number, i: number): number {
  if (i < period) return 0;
  return (ticks[i] - ticks[i - period]) / ticks[i - period];
}

// Função para calcular a volatilidade
function calculateVolatility(ticks: number[], period: number, i: number): number {
  if (i < period) return 0;
  const window = ticks.slice(i - period + 1, i + 1);
  const returns = window.slice(1).map((price, idx) => (price - window[idx]) / window[idx]);
  const media = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - media, 2), 0) / returns.length;
  return Math.sqrt(variance);
}

// Função para detectar reversão de tendência
function detectTrendReversal(ticks: number[], period: number, i: number): boolean {
  if (i < period * 2) return false;
  
  const previousPeriod = ticks.slice(i - period * 2, i - period);
  const currentPeriod = ticks.slice(i - period, i + 1);
  
  const previousTrend = (previousPeriod[previousPeriod.length - 1] - previousPeriod[0]) / previousPeriod[0];
  const currentTrend = (currentPeriod[currentPeriod.length - 1] - currentPeriod[0]) / currentPeriod[0];
  
  return Math.sign(previousTrend) !== Math.sign(currentTrend);
}

// Função para verificar se a entrada é válida considerando múltiplos fatores
function validateEntry(
  ticks: number[], 
  i: number, 
  entryType: 'CALL' | 'PUT',
  trendPeriod: number = 20,
  maxTrendForce: number = 0.5
): boolean {
  // 1. Verifica tendência
  const { direction, force } = detectTrend(ticks, trendPeriod, i);
  
  // 2. Calcula momentum
  const momentum = calculateMomentum(ticks, 5, i);
  
  // 3. Calcula volatilidade
  const volatility = calculateVolatility(ticks, 10, i);
  
  // 4. Verifica reversão
  const trendReversal = detectTrendReversal(ticks, 10, i);
  
  // Regras para CALL
  if (entryType === 'CALL') {
    // Não entra se a tendência de baixa for muito forte
    if (direction === 'BAIXA' && force > maxTrendForce) return false;
    
    // Não entra se o momentum for muito negativo
    if (momentum < -0.001) return false;
    
    // Não entra se a volatilidade for muito alta
    if (volatility > 0.002) return false;
    
    // Prefere entrar em momentos de reversão de baixa para alta
    if (trendReversal && direction === 'BAIXA') return true;
    
    // Permite entrada se a tendência for lateral ou fraca
    return direction === 'LATERAL' || force < maxTrendForce * 0.5;
  }
  
  // Regras para PUT
  if (entryType === 'PUT') {
    // Não entra se a tendência de alta for muito forte
    if (direction === 'ALTA' && force > maxTrendForce) return false;
    
    // Não entra se o momentum for muito positivo
    if (momentum > 0.001) return false;
    
    // Não entra se a volatilidade for muito alta
    if (volatility > 0.002) return false;
    
    // Prefere entrar em momentos de reversão de alta para baixa
    if (trendReversal && direction === 'ALTA') return true;
    
    // Permite entrada se a tendência for lateral ou fraca
    return direction === 'LATERAL' || force < maxTrendForce * 0.5;
  }
  
  return false;
}

function generateCriteria() {
  const criteriaArr: CriteriaSimulation[] = [];

  // Exemplo: N ticks consecutivos de alta/baixa com verificação de tendência
  for (let n = 2; n <= 5; n++) {
    criteriaArr.push({
      name: `CALL após ${n} ticks de baixa (com filtros avançados)`,
      type: "CALL",
      parameters: { n },
      minWindow: n + 1,
      condition: (ticks: number[], i: number) => {
        // Verifica todos os filtros
        if (!validateEntry(ticks, i, 'CALL')) return false;
        
        // Verifica sequência de baixas
        for (let j = 0; j < n; j++) {
          if (ticks[i - j] >= ticks[i - j - 1]) return false;
        }
        return true;
      },
    });
    
    criteriaArr.push({
      name: `PUT após ${n} ticks de alta (com filtros avançados)`,
      type: "PUT",
      parameters: { n },
      minWindow: n + 1,
      condition: (ticks: number[], i: number) => {
        // Verifica todos os filtros
        if (!validateEntry(ticks, i, 'PUT')) return false;
        
        // Verifica sequência de altas
        for (let j = 0; j < n; j++) {
          if (ticks[i - j] <= ticks[i - j - 1]) return false;
        }
        return true;
      },
    });
  }

  // Exemplo: Variação percentual com verificação de tendência
  for (let percent = 0.1; percent <= 0.5; percent += 0.1) {
    criteriaArr.push({
      name: `CALL se caiu mais de ${percent.toFixed(1)}% em 3 ticks (com filtro de tendência)`,
      type: "CALL",
      parameters: { percent },
      minWindow: 4,
      condition: (ticks: number[], i: number) => {
        if (i < 3) return false;
        if (!validateEntry(ticks, i, 'CALL')) return false;
        
        const variation = (ticks[i] - ticks[i - 3]) / ticks[i - 3];
        return variation <= -percent / 100;
      },
    });
    
    criteriaArr.push({
      name: `PUT se subiu mais de ${percent.toFixed(1)}% em 3 ticks (com filtro de tendência)`,
      type: "PUT",
      parameters: { percent },
      minWindow: 4,
      condition: (ticks: number[], i: number) => {
        if (i < 3) return false;
        if (!validateEntry(ticks, i, 'PUT')) return false;
        
        const variation = (ticks[i] - ticks[i - 3]) / ticks[i - 3];
        return variation >= percent / 100;
      },
    });
  }

  // Critério: Gap entre Ticks
  for (let percent = 0.1; percent <= 0.5; percent += 0.1) {
    criteriaArr.push({
      name: `CALL se gap negativo maior que ${percent.toFixed(1)}%`,
      type: "CALL",
      parameters: { percent },
      minWindow: 2,
      condition: (ticks: number[], i: number) => {
        if (i < 1) return false;
        if (!validateEntry(ticks, i, 'CALL')) return false;
        const variation = (ticks[i] - ticks[i - 1]) / ticks[i - 1];
        return variation <= -percent / 100;
      },
    });
    criteriaArr.push({
      name: `PUT se gap positivo maior que ${percent.toFixed(1)}%`,
      type: "PUT",
      parameters: { percent },
      minWindow: 2,
      condition: (ticks: number[], i: number) => {
        if (i < 1) return false;
        if (!validateEntry(ticks, i, 'PUT')) return false;
        const variation = (ticks[i] - ticks[i - 1]) / ticks[i - 1];
        return variation >= percent / 100;
      },
    });
  }

  // Critério: Alternância de Direção
  for (let n = 3; n <= 5; n++) {
    criteriaArr.push({
      name: `CALL se alternância de direção em ${n} ticks (termina em baixa)`,
      type: "CALL",
      parameters: { n },
      minWindow: n,
      condition: (ticks: number[], i: number) => {
        if (i < n - 1) return false;
        if (!validateEntry(ticks, i, 'CALL')) return false;
        let alterna = true;
        for (let j = 0; j < n - 1; j++) {
          const diff1 = ticks[i - j] - ticks[i - j - 1];
          const diff2 = ticks[i - j - 1] - ticks[i - j - 2];
          if (diff1 * diff2 >= 0) {
            alterna = false;
            break;
          }
        }
        // Só faz sentido CALL se o último movimento foi de baixa
        return alterna && ticks[i] < ticks[i - 1];
      },
    });
    criteriaArr.push({
      name: `PUT se alternância de direção em ${n} ticks (termina em alta)`,
      type: "PUT",
      parameters: { n },
      minWindow: n,
      condition: (ticks: number[], i: number) => {
        if (i < n - 1) return false;
        if (!validateEntry(ticks, i, 'PUT')) return false;
        let alterna = true;
        for (let j = 0; j < n - 1; j++) {
          const diff1 = ticks[i - j] - ticks[i - j - 1];
          const diff2 = ticks[i - j - 1] - ticks[i - j - 2];
          if (diff1 * diff2 >= 0) {
            alterna = false;
            break;
          }
        }
        // Só faz sentido PUT se o último movimento foi de alta
        return alterna && ticks[i] > ticks[i - 1];
      },
    });
  }

  // Critério: Volatilidade Baixa/Alta
  for (let n = 3; n <= 7; n += 2) {
    for (let lim = 0.05; lim <= 0.2; lim += 0.05) {
      criteriaArr.push({
        name: `CALL se volatilidade baixa (${n} ticks, variação <= ${lim.toFixed(
          2
        )}%)`,
        type: "CALL",
        parameters: { n, lim },
        minWindow: n,
        condition: (ticks: number[], i: number) => {
          if (i < n - 1) return false;
          if (!validateEntry(ticks, i, 'CALL')) return false;
          const janela = ticks.slice(i - n + 1, i + 1);
          const max = Math.max(...janela);
          const min = Math.min(...janela);
          const variacao = (max - min) / min;
          return variacao <= lim / 100;
        },
      });
      criteriaArr.push({
        name: `PUT se volatilidade alta (${n} ticks, variação >= ${lim.toFixed(
          2
        )}%)`,
        type: "PUT",
        parameters: { n, lim },
        minWindow: n,
        condition: (ticks: number[], i: number) => {
          if (i < n - 1) return false;
          if (!validateEntry(ticks, i, 'PUT')) return false;
          const janela = ticks.slice(i - n + 1, i + 1);
          const max = Math.max(...janela);
          const min = Math.min(...janela);
          const variacao = (max - min) / min;
          return variacao >= lim / 100;
        },
      });
    }
  }

  // Critério: Tick do Meio
  for (let n = 3; n <= 7; n += 2) {
    criteriaArr.push({
      name: `CALL se preço atual está abaixo da média dos últimos ${n} ticks`,
      type: "CALL",
      parameters: { n },
      minWindow: n,
      condition: (ticks: number[], i: number) => {
        if (i < n - 1) return false;
        if (!validateEntry(ticks, i, 'CALL')) return false;
        const janela = ticks.slice(i - n + 1, i + 1);
        const media = janela.reduce((a, b) => a + b, 0) / n;
        return ticks[i] < media;
      },
    });
    criteriaArr.push({
      name: `PUT se preço atual está acima da média dos últimos ${n} ticks`,
      type: "PUT",
      parameters: { n },
      minWindow: n,
      condition: (ticks: number[], i: number) => {
        if (i < n - 1) return false;
        if (!validateEntry(ticks, i, 'PUT')) return false;
        const janela = ticks.slice(i - n + 1, i + 1);
        const media = janela.reduce((a, b) => a + b, 0) / n;
        return ticks[i] > media;
      },
    });
  }

  // Critério: Cruzamento de Média Móvel Curta
  for (let n = 3; n <= 7; n += 2) {
    criteriaArr.push({
      name: `CALL cruzou acima da média móvel de ${n} ticks`,
      type: "CALL",
      parameters: { n },
      minWindow: n + 1,
      condition: (ticks: number[], i: number) => {
        if (i < n) return false;
        if (!validateEntry(ticks, i, 'CALL')) return false;
        const media = ticks.slice(i - n, i).reduce((a, b) => a + b, 0) / n;
        // Cruzamento: estava abaixo e agora está acima
        return ticks[i - 1] < media && ticks[i] > media;
      },
    });
    criteriaArr.push({
      name: `PUT cruzou abaixo da média móvel de ${n} ticks`,
      type: "PUT",
      parameters: { n },
      minWindow: n + 1,
      condition: (ticks: number[], i: number) => {
        if (i < n) return false;
        if (!validateEntry(ticks, i, 'PUT')) return false;
        const media = ticks.slice(i - n, i).reduce((a, b) => a + b, 0) / n;
        // Cruzamento: estava acima e agora está abaixo
        return ticks[i - 1] > media && ticks[i] < media;
      },
    });
  }

  // Função auxiliar para calcular RSI
  function calcularRSI(ticks: number[], periodo: number, i: number): number {
    if (i < periodo) return 50; // Valor neutro se não há dados suficientes
    let ganhos = 0;
    let perdas = 0;
    for (let j = i - periodo + 1; j <= i; j++) {
      const diff = ticks[j] - ticks[j - 1];
      if (diff > 0) ganhos += diff;
      else perdas -= diff;
    }
    const rs = perdas === 0 ? 100 : ganhos / perdas;
    return 100 - 100 / (1 + rs);
  }

  // Critério: RSI Curto
  for (let n = 3; n <= 7; n += 2) {
    criteriaArr.push({
      name: `CALL se RSI(${n}) < 30`,
      type: "CALL",
      parameters: { n },
      minWindow: n + 1,
      condition: (ticks: number[], i: number) => {
        if (i < n) return false;        
        const rsi = calcularRSI(ticks, n, i);
        return rsi < 30;
      },
    });
    criteriaArr.push({
      name: `PUT se RSI(${n}) > 70`,
      type: "PUT",
      parameters: { n },
      minWindow: n + 1,
      condition: (ticks: number[], i: number) => {
        if (i < n) return false;
        const rsi = calcularRSI(ticks, n, i);
        return rsi > 70;
      },
    });
  }

  return criteriaArr;
}

export async function runCallPut() {
  const count = 20_000;

  const data = (await loadHistoricalData({
    symbol: "R_100",
    count: count, // 12 hours
    format: "ticks",
  }));

  const historico: number[] = data.ticks.map((tick) => tick.price);
  const duracao = 10;

  // Divide em blocos
  const blocoOtimizacao = historico.slice(0, historico.length / 2);
  const blocoValidacao = historico.slice(historico.length / 2, historico.length);

  // Otimiza nos primeiros 5k
  const resultadosOtimizacao = findBestCriteria(
    blocoOtimizacao,
    duracao
  );
  const melhoresOtimizacao = resultadosOtimizacao.filter(
    (r) => r.winRate >= 0 // 0.525
  );

  // console.log("Melhores critérios na OTIMIZAÇÃO:");
  // console.table(melhoresOtimizacao.slice(0, 5));

  // Valida os melhores critérios nos próximos 5k
  const criteriosParaValidar = melhoresOtimizacao.map((r) => r.criteria);
  const criteriosMap = new Map(melhoresOtimizacao.map((r) => [r.criteria, r]));

  // Reaplica os critérios encontrados na validação
  const criterios = generateCriteria();
  const resultadosValidacao: SimulationResult[] = [];
  for (const criterio of criterios) {
    if (!criteriosParaValidar.includes(criterio.name)) continue;
    let wins = 0;
    let total = 0;
    for (let i = 0; i < blocoValidacao.length - duracao; i++) {
      if (criterio.condition(blocoValidacao, i)) {
        total++;
        const precoEntrada = blocoValidacao[i];
        const precoSaida = blocoValidacao[i + duracao];
        if (criterio.type === "CALL" && precoSaida > precoEntrada) wins++;
        if (criterio.type === "PUT" && precoSaida < precoEntrada) wins++;
      }
    }
    resultadosValidacao.push({
      criteria: criterio.name,
      parameters: criteriosMap.get(criterio.name)?.parameters || {},
      winRate: total > 0 ? wins / total : 0,
      totalEntries: total,
      criteriaObj: criterio,
    });
  }

  const resultadosOrdenados = resultadosValidacao.sort(
    (a, b) => b.winRate - a.winRate
  );

  const resultadosFiltrados = resultadosOrdenados.filter(
    (r) => (r.winRate >= 0.525 && r.totalEntries > 1)
  );

  const bestCriterios = resultadosFiltrados.map((r) => r.criteriaObj);

  const criteriasCount = new Map<string, number>();
  for (const criterio of bestCriterios) {
    criteriasCount.set(criterio.type, (criteriasCount.get(criterio.type) || 0) + 1);
  }
  const bestSide = (criteriasCount.get("CALL") ?? 0) > (criteriasCount.get("PUT") ?? 0) ? "CALL" : "PUT";

  const bestCriteriosForSide = bestCriterios.filter((r) => r.type === bestSide);

  // console.log("Melhores critérios para o lado:", bestSide);
  // console.log("Desempenho dos melhores critérios na VALIDAÇÃO:");
  // console.table(resultadosFiltrados);
  return bestCriteriosForSide;
}

export function isTrendUp(ticks: number[], period: number, i: number, limit: number = 0): boolean {
  if (i < period) return false;
  if(ticks.length < period) return false;
  const ticksSlice = ticks.slice(-period);
  const inicio = ticksSlice.at(0) ?? 1;
  const fim = ticksSlice.at(-1) ?? 1;
  const variacao = (fim - inicio) / inicio;
  if(!inicio || !fim) return false;
  return variacao > limit;
}

type TCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number;
}

export function calculateCandleTrend(
  candles: TCandle[],
  periodo: number = 8, // Reduzido para 8 candles para ser mais responsivo
  limit: number = 0.0015 // 0.1% para ser mais sensível
): "bullish" | "bearish" | "sideways" {
  if (candles.length < periodo) return "sideways";
  
  const slice = candles.slice(-periodo);
  
  const primeiro = slice[0].close;
  const ultimo = slice[slice.length - 1].close;
  const variacao = (ultimo - primeiro) / primeiro;  

  if(variacao > limit) return "bullish";
  if(variacao < -limit) return "bearish";
  return "sideways";
}