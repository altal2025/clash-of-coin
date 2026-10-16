import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import confetti from 'canvas-confetti';
import { storage } from '../services/storage';
import { soundManager } from '../services/sound';
import {
  ConnectedWalletState,
  UserProfile,
  CrashHistoryItem,
  CrashParticipant,
} from '../types';
import {
  History,
  BookOpen,
  Plus,
  Users,
  Coins,
  TrendingUp,
  ShieldCheck,
  Zap,
  X,
  Play,
  Pause,
  ArrowUpRight,
} from 'lucide-react';
import { DepositModal } from './DepositModal';
import { RulesModal } from './RulesModal';

export type CrashGameState = 'WAITING' | 'FLYING' | 'CRASHED';

interface CrashGameProps {
  user: UserProfile;
  walletState: ConnectedWalletState;
  onUpdateUser: (data: Partial<UserProfile>) => void;
  onShowNotification: (type: 'success' | 'error' | 'win', msg: string) => void;
  onOpenDepositModal?: () => void;
}

export interface BetSlotState {
  amount: number;
  isPlaced: boolean;
  cashedOut: boolean;
  cashoutMultiplier: number | null;
  payout: number | null;
  autoPlayEnabled: boolean;
  autoCashoutEnabled: boolean;
  autoCashoutValue: number;
  source: 'SITE_BALANCE' | 'WEB3_WALLET';
}

// Egyptian phone numbers & handles partially masked for realistic multiplayer feel
const BOT_TEMPLATES = [
  { name: '0101*****', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=cairo1', baseBet: 100 },
  { name: '0122*****', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=alex2', baseBet: 200 },
  { name: '0114*****', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=giza3', baseBet: 50 },
  { name: '0155*****', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=mansoura4', baseBet: 400 },
  { name: '079******', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=tanta5', baseBet: 50 },
  { name: '0109*****', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=suez6', baseBet: 1000 },
  { name: '0128*****', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=aswan7', baseBet: 150 },
  { name: '0111*****', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=ismailia8', baseBet: 500 },
];

/**
 * Real Crash Point Generation (Server/State Logic)
 * House edge: 3%, 5% instant crash at 1.00x
 */
function generateCrashPoint(): { point: number; hash: string } {
  const houseEdge = 0.03; // 3%
  const r = Math.random();
  let point = 1.0;
  if (r < 0.05) {
    point = 1.0; // 5% instant crash
  } else {
    point = Math.max(1.0, (0.97 / (1 - r)) * (1 - houseEdge));
  }
  const finalMult = Number(point.toFixed(2));
  const hash =
    '0x' + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return { point: finalMult, hash };
}

export const CrashGame: React.FC<CrashGameProps> = ({
  user,
  walletState,
  onUpdateUser,
  onShowNotification,
  onOpenDepositModal,
}) => {
  const { i18n } = useTranslation();
  const isAr = i18n.language === 'ar';

  const isEgypt = user.country === 'EG' || user.currency === 'EGP';
  const currencySymbol = isEgypt ? 'ج.م' : 'USDT';

  // Game state visible to React
  const [gameState, setGameState] = useState<CrashGameState>('WAITING');
  const [countdown, setCountdown] = useState<number>(5.0);
  const [multiplier, setMultiplier] = useState<number>(1.0);
  const [crashPoint, setCrashPoint] = useState<number>(() => {
    const init = generateCrashPoint();
    return init.point;
  });
  const [currentRoundHash, setCurrentRoundHash] = useState<string>('0x7a8f...39c');
  const [history, setHistory] = useState<CrashHistoryItem[]>(() => storage.getCrashHistory());

  // Dual Betting Slots State
  const [bet1, setBet1] = useState<BetSlotState>({
    amount: 50,
    isPlaced: false,
    cashedOut: false,
    cashoutMultiplier: null,
    payout: null,
    autoPlayEnabled: false,
    autoCashoutEnabled: false,
    autoCashoutValue: 2.0,
    source: 'SITE_BALANCE',
  });

  const [bet2, setBet2] = useState<BetSlotState>({
    amount: 100,
    isPlaced: false,
    cashedOut: false,
    cashoutMultiplier: null,
    payout: null,
    autoPlayEnabled: false,
    autoCashoutEnabled: false,
    autoCashoutValue: 3.0,
    source: 'SITE_BALANCE',
  });

  // Simulated active round participants
  const [participants, setParticipants] = useState<CrashParticipant[]>([]);

  // Statistics
  const [totalBetsCount, setTotalBetsCount] = useState<number>(14280);
  const [totalBetsAmount, setTotalBetsAmount] = useState<number>(1845200.0);
  const [totalProfitAmount, setTotalProfitAmount] = useState<number>(43210.5);

  // Modals
  const [isDepositOpen, setIsDepositOpen] = useState(false);
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<CrashHistoryItem | null>(null);

  // Canvas & Animation References
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameIdRef = useRef<number | null>(null);

  // Robust State Machine Refs (protects from re-render resets)
  const gameStateRef = useRef<CrashGameState>('WAITING');
  const waitingStartTimeRef = useRef<number>(performance.now());
  const flightStartTimeRef = useRef<number>(0);
  const crashStartTimeRef = useRef<number>(0);
  const multiplierRef = useRef<number>(1.0);
  const crashPointRef = useRef<number>(crashPoint);
  const roundHashRef = useRef<string>(currentRoundHash);

  // Live mirror refs for user & bets inside requestAnimationFrame
  const userRef = useRef<UserProfile>(user);
  const walletStateRef = useRef<ConnectedWalletState>(walletState);
  const bet1Ref = useRef<BetSlotState>(bet1);
  const bet2Ref = useRef<BetSlotState>(bet2);
  const participantsRef = useRef<CrashParticipant[]>([]);

  // Plane position & visual effects refs
  const lastPlanePosRef = useRef<{ x: number; y: number; angle: number }>({ x: 50, y: 350, angle: 0 });
  const exhaustParticlesRef = useRef<
    Array<{ x: number; y: number; vx: number; vy: number; life: number; decay: number; size: number; color: string }>
  >([]);
  const explosionParticlesRef = useRef<
    Array<{ x: number; y: number; vx: number; vy: number; rot: number; vrot: number; size: number; life: number; decay: number; color: string }>
  >([]);
  const shockwaveRef = useRef<{ radius: number; maxRadius: number; alpha: number }>({ radius: 0, maxRadius: 0, alpha: 0 });

  // Sync state refs
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    walletStateRef.current = walletState;
  }, [walletState]);

  useEffect(() => {
    bet1Ref.current = bet1;
  }, [bet1]);

  useEffect(() => {
    bet2Ref.current = bet2;
  }, [bet2]);

  // Setup participants for a new round
  const setupParticipants = useCallback(() => {
    const list: CrashParticipant[] = BOT_TEMPLATES.map((bot, idx) => {
      const variance = Math.random() * 40 - 20;
      const amount = Math.max(10, Math.round(bot.baseBet + variance));
      return {
        id: `bot_${idx}_${Date.now()}`,
        name: bot.name,
        avatar: bot.avatar,
        betAmount: amount,
        cashedOut: false,
      };
    });
    setParticipants(list);
    participantsRef.current = list;
  }, []);

  // Execute cashout for slot 1 or 2
  const executeCashout = useCallback(
    (slotIndex: 1 | 2) => {
      const curMult = multiplierRef.current;
      if (gameStateRef.current !== 'FLYING' || curMult < 1.01) return;

      const targetRef = slotIndex === 1 ? bet1Ref : bet2Ref;
      const setTarget = slotIndex === 1 ? setBet1 : setBet2;
      const currentSlot = targetRef.current;

      if (!currentSlot.isPlaced || currentSlot.cashedOut) return;

      // Real balance payout via storage
      const res = storage.cashOutCrashBet(currentSlot.amount, curMult, currentSlot.source);
      if (res.success) {
        soundManager.playCashout();

        const updatedSlot: BetSlotState = {
          ...currentSlot,
          cashedOut: true,
          cashoutMultiplier: curMult,
          payout: res.payout,
        };

        targetRef.current = updatedSlot;
        setTarget(updatedSlot);

        // Update global user balance
        const updatedUser = storage.getUser();
        onUpdateUser(updatedUser);

        // Update statistics
        setTotalProfitAmount((p) => Number((p + res.profit).toFixed(1)));

        // Celebrate with confetti
        confetti({
          particleCount: 70,
          spread: 75,
          origin: { y: 0.62 },
          colors: ['#10B981', '#F59E0B', '#FDE047', '#FFFFFF'],
        });

        onShowNotification(
          'win',
          isAr
            ? `كاش أوت ناجح! ربحت ${res.payout} ${currencySymbol} (ربح: +${res.profit} ${currencySymbol}) عند ${curMult.toFixed(2)}x`
            : `Cash out success! Won ${res.payout} ${currencySymbol} (+${res.profit} profit) at ${curMult.toFixed(2)}x`
        );
      }
    },
    [onUpdateUser, onShowNotification, isAr, currencySymbol]
  );

  // Initialize participants on first render
  useEffect(() => {
    setupParticipants();
  }, [setupParticipants]);

  // Master Game State Machine & High-Performance Canvas Animation Loop
  // (Uses single requestAnimationFrame, strictly monotonic time, NO setInterval)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Helper: Draw the 1xBet Sleek Yellow Jet Airplane
    const drawPlane = (
      c: CanvasRenderingContext2D,
      x: number,
      y: number,
      rot: number,
      scale: number = 1
    ) => {
      c.save();
      c.translate(x, y);
      c.rotate(rot);
      c.scale(scale, scale);

      // 1. Dynamic Jet Thruster Flame
      const flameLen = 18 + Math.sin(performance.now() / 30) * 7;
      const fGrad = c.createLinearGradient(-18, 0, -18 - flameLen, 0);
      fGrad.addColorStop(0, '#FFFFFF');
      fGrad.addColorStop(0.2, '#FDE047');
      fGrad.addColorStop(0.6, '#F59E0B');
      fGrad.addColorStop(1, 'rgba(239, 68, 68, 0)');

      c.fillStyle = fGrad;
      c.beginPath();
      c.moveTo(-18, -4);
      c.lineTo(-18 - flameLen, 0);
      c.lineTo(-18, 4);
      c.closePath();
      c.fill();

      // 2. Main Fuselage (Yellow / Gold Jet)
      const bodyGrad = c.createLinearGradient(0, -6, 0, 6);
      bodyGrad.addColorStop(0, '#FDE047');
      bodyGrad.addColorStop(0.5, '#F59E0B');
      bodyGrad.addColorStop(1, '#D97706');
      c.fillStyle = bodyGrad;
      c.beginPath();
      c.ellipse(0, 0, 25, 7, 0, 0, Math.PI * 2);
      c.fill();

      // Upper aerodynamic highlight
      c.fillStyle = 'rgba(255, 255, 255, 0.6)';
      c.beginPath();
      c.ellipse(3, -2.5, 18, 2.5, 0, 0, Math.PI * 2);
      c.fill();

      // 3. Top Delta Wing (Amber/Gold)
      c.fillStyle = '#D97706';
      c.beginPath();
      c.moveTo(-4, -4);
      c.lineTo(-16, -24);
      c.lineTo(7, -4);
      c.closePath();
      c.fill();

      // Wingtip Red Navigation Light
      c.fillStyle = '#EF4444';
      c.beginPath();
      c.arc(-16, -24, 2.2, 0, Math.PI * 2);
      c.fill();

      // 4. Bottom Delta Wing
      c.fillStyle = '#B45309';
      c.beginPath();
      c.moveTo(-4, 4);
      c.lineTo(-16, 24);
      c.lineTo(7, 4);
      c.closePath();
      c.fill();

      // Wingtip Green Navigation Light
      c.fillStyle = '#10B981';
      c.beginPath();
      c.arc(-16, 24, 2.2, 0, Math.PI * 2);
      c.fill();

      // 5. Vertical Tail Fin & Rudder
      c.fillStyle = '#EA580C';
      c.beginPath();
      c.moveTo(-15, 0);
      c.lineTo(-24, -13);
      c.lineTo(-12, 0);
      c.closePath();
      c.fill();

      // 6. Cockpit Canopy Glass (Glossy Cyan reflection)
      const glassGrad = c.createLinearGradient(6, -4, 15, 0);
      glassGrad.addColorStop(0, '#FFFFFF');
      glassGrad.addColorStop(0.4, '#BAE6FD');
      glassGrad.addColorStop(1, '#0284C7');
      c.fillStyle = glassGrad;
      c.beginPath();
      c.ellipse(9, -1, 7.5, 3.2, 0, 0, Math.PI * 2);
      c.fill();

      c.restore();
    };

    let lastTickSecond = 5;

    // Master Animation Frame Loop
    const frameLoop = () => {
      const now = performance.now();
      const currentState = gameStateRef.current;

      // Ensure canvas matches displayed dimension
      const rect = canvas.getBoundingClientRect();
      const targetW = Math.max(700, Math.round(rect.width || 900));
      const targetH = Math.max(380, Math.round(rect.height || 420));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const width = canvas.width;
      const height = canvas.height;

      // 1xBet signature dark navy blue background (#0e1929)
      ctx.fillStyle = '#0e1929';
      ctx.fillRect(0, 0, width, height);

      // Fine coordinate grid lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      const gridStep = 40;
      for (let x = 0; x < width; x += gridStep) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += gridStep) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Origin Axes
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(35, height - 35);
      ctx.lineTo(width - 20, height - 35);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(35, height - 35);
      ctx.lineTo(35, 20);
      ctx.stroke();

      // Flight coordinates
      const startX = 45;
      const startY = height - 42;
      const maxFlightW = width - 160;
      const maxFlightH = height - 85;

      // -------------------------------------------------------------
      // STATE 1: WAITING (5.0s countdown before takeoff)
      // -------------------------------------------------------------
      if (currentState === 'WAITING') {
        const elapsedWaiting = now - waitingStartTimeRef.current;
        const remainingSec = Math.max(0, (5000 - elapsedWaiting) / 1000);
        setCountdown(Number(remainingSec.toFixed(1)));

        // Audio tick in final 3 seconds
        const currentSecInt = Math.ceil(remainingSec);
        if (currentSecInt !== lastTickSecond && currentSecInt <= 3 && currentSecInt > 0) {
          lastTickSecond = currentSecInt;
          soundManager.playTick();
        }

        // Draw runway marking
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.setLineDash([12, 10]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(35, startY + 10);
        ctx.lineTo(width - 20, startY + 10);
        ctx.stroke();
        ctx.restore();

        // Idle gentle bob on the runway
        const idleBob = Math.sin(now / 220) * 1.5;
        drawPlane(ctx, startX, startY + idleBob, 0, 1.0);
        lastPlanePosRef.current = { x: startX, y: startY, angle: 0 };

        // Check if countdown ended -> transition to FLYING
        if (elapsedWaiting >= 5000) {
          gameStateRef.current = 'FLYING';
          flightStartTimeRef.current = performance.now();
          multiplierRef.current = 1.0;
          setGameState('FLYING');
          setMultiplier(1.0);
          soundManager.playPlaneTakeoff();
        }
      }

      // -------------------------------------------------------------
      // STATE 2: FLYING (Smooth exponential curve & dynamic multiplier)
      // Multiplier formula: multiplier = Math.pow(1.005, elapsedTime * 6)
      // -------------------------------------------------------------
      else if (currentState === 'FLYING') {
        const elapsedSec = (now - flightStartTimeRef.current) / 1000;
        // Dynamically compute multiplier strictly with Math.pow(1.005, elapsedTime * 6)
        const currentMult = Math.pow(1.005, elapsedSec * 6);
        multiplierRef.current = currentMult;
        setMultiplier(Number(currentMult.toFixed(2)));

        // Check Auto Cashout for Bet 1
        const b1 = bet1Ref.current;
        if (b1.isPlaced && !b1.cashedOut && b1.autoCashoutEnabled && currentMult >= b1.autoCashoutValue) {
          executeCashout(1);
        }

        // Check Auto Cashout for Bet 2
        const b2 = bet2Ref.current;
        if (b2.isPlaced && !b2.cashedOut && b2.autoCashoutEnabled && currentMult >= b2.autoCashoutValue) {
          executeCashout(2);
        }

        // Bot participants cashouts simulation
        if (Math.random() < 0.04 && currentMult > 1.25) {
          const list = participantsRef.current;
          const uncashed = list.filter((p) => !p.cashedOut);
          if (uncashed.length > 0) {
            const targetBot = uncashed[Math.floor(Math.random() * uncashed.length)];
            targetBot.cashedOut = true;
            targetBot.cashoutMultiplier = Number(currentMult.toFixed(2));
            targetBot.profit = Number((targetBot.betAmount * currentMult - targetBot.betAmount).toFixed(1));
            setParticipants([...list]);
          }
        }

        // Smooth visual flight progress (asymptotic mapping from 1.0x to 100x+)
        const normalized = Math.max(0, currentMult - 1.0) / (currentMult + 1.6);
        const progress = Math.min(0.95, Math.pow(normalized, 0.72) * 1.12);

        const targetX = startX + progress * maxFlightW;
        const targetY = startY - progress * maxFlightH;

        // Cubic Bezier Control Points for smooth ascending curve (ctx.bezierCurveTo)
        const cp1x = startX + (targetX - startX) * 0.45;
        const cp1y = startY;
        const cp2x = startX + (targetX - startX) * 0.82;
        const cp2y = startY - (startY - targetY) * 0.38;

        // Tangent vector derivative at t=1: 3 * (target - cp2)
        const tangentDx = 3 * (targetX - cp2x);
        const tangentDy = 3 * (targetY - cp2y);
        const baseAngle = Math.atan2(tangentDy, tangentDx);

        // Gentle flight vibration
        const hoverY = Math.sin(now / 140) * 2.0;
        const hoverAngle = Math.cos(now / 180) * 0.025;

        const planeX = targetX;
        const planeY = targetY + hoverY;
        const planeAngle = baseAngle + hoverAngle;

        lastPlanePosRef.current = { x: planeX, y: planeY, angle: planeAngle };

        // 1. Shaded area below the smooth Bezier curve
        const fillGrad = ctx.createLinearGradient(0, planeY, 0, startY);
        fillGrad.addColorStop(0, 'rgba(245, 158, 11, 0.35)');
        fillGrad.addColorStop(0.7, 'rgba(245, 158, 11, 0.08)');
        fillGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)');

        ctx.fillStyle = fillGrad;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, planeX, planeY);
        ctx.lineTo(planeX, startY);
        ctx.closePath();
        ctx.fill();

        // 2. Trajectory Glow Stroke (Bloom pass)
        ctx.save();
        ctx.lineWidth = 7;
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
        ctx.shadowColor = '#F59E0B';
        ctx.shadowBlur = 16;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, planeX, planeY);
        ctx.stroke();
        ctx.restore();

        // 3. Core Golden Yellow Path Line
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#FDE047';
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, planeX, planeY);
        ctx.stroke();

        // 4. Exhaust Particles
        const tailOffset = 22;
        const tailX = planeX - Math.cos(planeAngle) * tailOffset;
        const tailY = planeY - Math.sin(planeAngle) * tailOffset;

        for (let i = 0; i < 2; i++) {
          const spread = (Math.random() - 0.5) * 0.4;
          const pAngle = planeAngle + Math.PI + spread;
          const speed = 2.5 + Math.random() * 3.5;
          exhaustParticlesRef.current.push({
            x: tailX,
            y: tailY,
            vx: Math.cos(pAngle) * speed,
            vy: Math.sin(pAngle) * speed,
            life: 1.0,
            decay: 0.04 + Math.random() * 0.03,
            size: 4 + Math.random() * 4,
            color: Math.random() > 0.4 ? '#F59E0B' : Math.random() > 0.5 ? '#FDE047' : '#EF4444',
          });
        }

        // Draw the Yellow Jet
        drawPlane(ctx, planeX, planeY, planeAngle, 1.0);

        // Check if Plane Crashed (multiplier >= crashPoint)
        if (currentMult >= crashPointRef.current) {
          gameStateRef.current = 'CRASHED';
          crashStartTimeRef.current = performance.now();
          multiplierRef.current = crashPointRef.current;
          setGameState('CRASHED');
          setMultiplier(crashPointRef.current);
          soundManager.playPlaneCrash();

          // Spawn explosion particles
          const pX = lastPlanePosRef.current.x;
          const pY = lastPlanePosRef.current.y;
          const debrisColors = ['#EF4444', '#F59E0B', '#F97316', '#FBBF24', '#FFFFFF', '#DC2626'];
          const parts = [];
          for (let i = 0; i < 45; i++) {
            const pAngle = Math.random() * Math.PI * 2;
            const speed = 3.0 + Math.random() * 8;
            parts.push({
              x: pX,
              y: pY,
              vx: Math.cos(pAngle) * speed,
              vy: Math.sin(pAngle) * speed,
              rot: Math.random() * Math.PI * 2,
              vrot: (Math.random() - 0.5) * 0.4,
              size: 3 + Math.random() * 6,
              life: 1.0,
              decay: 0.02 + Math.random() * 0.025,
              color: debrisColors[Math.floor(Math.random() * debrisColors.length)],
            });
          }
          explosionParticlesRef.current = parts;
          shockwaveRef.current = { radius: 8, maxRadius: 90, alpha: 1.0 };

          // Record losses for uncashed user bets
          const activeBet1 = bet1Ref.current;
          if (activeBet1.isPlaced && !activeBet1.cashedOut) {
            storage.recordCrashLoss(activeBet1.amount);
          }
          const activeBet2 = bet2Ref.current;
          if (activeBet2.isPlaced && !activeBet2.cashedOut) {
            storage.recordCrashLoss(activeBet2.amount);
          }

          // Save round to history
          storage.addCrashHistory(crashPointRef.current, roundHashRef.current);
          setHistory([...storage.getCrashHistory()]);
        }
      }

      // -------------------------------------------------------------
      // STATE 3: CRASHED (3.0s explosion and Flew Away display)
      // -------------------------------------------------------------
      else if (currentState === 'CRASHED') {
        const elapsedCrash = now - crashStartTimeRef.current;

        // Draw fading trajectory line in red
        const pX = lastPlanePosRef.current.x;
        const pY = lastPlanePosRef.current.y;
        const cp1x = startX + (pX - startX) * 0.45;
        const cp1y = startY;
        const cp2x = startX + (pX - startX) * 0.82;
        const cp2y = startY - (startY - pY) * 0.38;

        const fillGrad = ctx.createLinearGradient(0, pY, 0, startY);
        fillGrad.addColorStop(0, 'rgba(239, 68, 68, 0.3)');
        fillGrad.addColorStop(1, 'rgba(239, 68, 68, 0.0)');
        ctx.fillStyle = fillGrad;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, pX, pY);
        ctx.lineTo(pX, startY);
        ctx.closePath();
        ctx.fill();

        ctx.lineWidth = 3;
        ctx.strokeStyle = '#EF4444';
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, pX, pY);
        ctx.stroke();

        // Expanding Shockwave Ring
        if (shockwaveRef.current.alpha > 0.01) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(pX, pY, shockwaveRef.current.radius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(239, 68, 68, ${shockwaveRef.current.alpha * 0.9})`;
          ctx.lineWidth = 3.5;
          ctx.stroke();
          ctx.restore();

          shockwaveRef.current.radius += 3.2;
          shockwaveRef.current.alpha *= 0.94;
        }

        // Explosion Debris Shards
        explosionParticlesRef.current.forEach((p) => {
          if (p.life > 0) {
            p.x += p.vx;
            p.y += p.vy;
            p.rot += p.vrot;
            p.life -= p.decay;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
            ctx.restore();
          }
        });

        // Central Fiery Explosion Flash
        ctx.save();
        const flashGrad = ctx.createRadialGradient(pX, pY, 2, pX, pY, 34);
        flashGrad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        flashGrad.addColorStop(0.3, 'rgba(245, 158, 11, 0.85)');
        flashGrad.addColorStop(0.7, 'rgba(239, 68, 68, 0.5)');
        flashGrad.addColorStop(1, 'rgba(239, 68, 68, 0)');
        ctx.fillStyle = flashGrad;
        ctx.beginPath();
        ctx.arc(pX, pY, 34, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // After 3.0 seconds -> Transition back to WAITING
        if (elapsedCrash >= 3000) {
          // Generate crash point BEFORE round starts
          const nextData = generateCrashPoint();
          crashPointRef.current = nextData.point;
          roundHashRef.current = nextData.hash;
          setCrashPoint(nextData.point);
          setCurrentRoundHash(nextData.hash);

          // Reset timers and states
          gameStateRef.current = 'WAITING';
          waitingStartTimeRef.current = performance.now();
          multiplierRef.current = 1.0;
          setGameState('WAITING');
          setMultiplier(1.0);
          setCountdown(5.0);
          lastTickSecond = 5;

          // Clear particles
          exhaustParticlesRef.current = [];
          explosionParticlesRef.current = [];
          shockwaveRef.current = { radius: 0, maxRadius: 0, alpha: 0 };

          // Handle Auto Play for Slot 1
          setBet1((prev) => {
            if (prev.autoPlayEnabled) {
              const freshUser = storage.getUser();
              if (freshUser.balance >= prev.amount) {
                storage.placeCrashBet(prev.amount, prev.source);
                onUpdateUser(storage.getUser());
                return {
                  ...prev,
                  isPlaced: true,
                  cashedOut: false,
                  cashoutMultiplier: null,
                  payout: null,
                };
              } else {
                onShowNotification('error', isAr ? 'الرصيد غير كافٍ للتشغيل التلقائي.' : 'Insufficient balance for auto bet.');
                return {
                  ...prev,
                  autoPlayEnabled: false,
                  isPlaced: false,
                  cashedOut: false,
                  cashoutMultiplier: null,
                  payout: null,
                };
              }
            }
            return {
              ...prev,
              isPlaced: false,
              cashedOut: false,
              cashoutMultiplier: null,
              payout: null,
            };
          });

          // Handle Auto Play for Slot 2
          setBet2((prev) => {
            if (prev.autoPlayEnabled) {
              const freshUser = storage.getUser();
              if (freshUser.balance >= prev.amount) {
                storage.placeCrashBet(prev.amount, prev.source);
                onUpdateUser(storage.getUser());
                return {
                  ...prev,
                  isPlaced: true,
                  cashedOut: false,
                  cashoutMultiplier: null,
                  payout: null,
                };
              } else {
                return {
                  ...prev,
                  autoPlayEnabled: false,
                  isPlaced: false,
                  cashedOut: false,
                  cashoutMultiplier: null,
                  payout: null,
                };
              }
            }
            return {
              ...prev,
              isPlaced: false,
              cashedOut: false,
              cashoutMultiplier: null,
              payout: null,
            };
          });

          // Dynamic stats volume
          setTotalBetsCount((c) => c + Math.floor(Math.random() * 5) + 1);
          setTotalBetsAmount((a) => Number((a + Math.random() * 350 + 50).toFixed(1)));

          // Refresh bot participants
          setupParticipants();
        }
      }

      // Render Exhaust Particles
      for (let i = exhaustParticlesRef.current.length - 1; i >= 0; i--) {
        const p = exhaustParticlesRef.current[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        p.size *= 0.96;

        if (p.life <= 0) {
          exhaustParticlesRef.current.splice(i, 1);
        } else {
          ctx.save();
          ctx.fillStyle = p.color;
          ctx.globalAlpha = Math.max(0, p.life * 0.85);
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      animFrameIdRef.current = requestAnimationFrame(frameLoop);
    };

    animFrameIdRef.current = requestAnimationFrame(frameLoop);

    return () => {
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
    };
  }, [executeCashout, isAr, onShowNotification, onUpdateUser, setupParticipants]);

  // Place or Cancel Bet handler
  const handleToggleBet = (slotIndex: 1 | 2) => {
    const targetState = slotIndex === 1 ? bet1 : bet2;
    const setTarget = slotIndex === 1 ? setBet1 : setBet2;

    // If bet already placed: allow cancellation during WAITING only
    if (targetState.isPlaced) {
      if (gameStateRef.current === 'WAITING') {
        storage.refundCrashBet(targetState.amount, targetState.source);
        onUpdateUser(storage.getUser());
        setTarget((prev) => ({ ...prev, isPlaced: false }));
        onShowNotification('success', isAr ? 'تم إلغاء الرهان واسترجاع المبلغ.' : 'Bet cancelled and refunded.');
      }
      return;
    }

    // Placing a bet: must be in WAITING state
    if (gameStateRef.current !== 'WAITING') {
      onShowNotification(
        'error',
        isAr ? 'لا يمكن المراهنة أثناء طيران الطائرة. انتظر الجولة التالية.' : 'Cannot bet while flying. Wait for next round.'
      );
      return;
    }

    if (targetState.amount <= 0) {
      onShowNotification('error', isAr ? 'يرجى تحديد مبلغ الرهان.' : 'Please enter bet amount.');
      return;
    }

    const res = storage.placeCrashBet(targetState.amount, targetState.source);
    if (!res.success) {
      onShowNotification('error', res.error || (isAr ? 'فشل تسجيل الرهان.' : 'Failed to place bet.'));
      return;
    }

    soundManager.playPlaceBet();
    setTarget((prev) => ({
      ...prev,
      isPlaced: true,
      cashedOut: false,
      cashoutMultiplier: null,
      payout: null,
    }));
    onUpdateUser(storage.getUser());

    onShowNotification(
      'success',
      isAr
        ? `تم وضع الرهان: ${targetState.amount} ${currencySymbol} (لوحة #${slotIndex})`
        : `Bet placed: ${targetState.amount} ${currencySymbol} (Panel #${slotIndex})`
    );
  };

  // Multiplier Badge Color styling for last 10 crash points
  // - Blue for < 2.0x
  // - Purple for 2.0x - 10.0x
  // - Gold for > 10.0x
  const getMultiplierBadgeStyle = (mult: number) => {
    if (mult < 2.0) {
      return 'bg-[#132238] text-[#38BDF8] border-[#38BDF8]/30 hover:border-[#38BDF8]';
    } else if (mult < 10.0) {
      return 'bg-[#281338] text-[#C084FC] border-[#C084FC]/40 hover:border-[#C084FC] font-bold';
    } else {
      return 'bg-[#382b13] text-[#FDE047] border-[#FDE047]/60 hover:border-[#FDE047] font-black shadow-[0_0_12px_rgba(253,224,71,0.25)]';
    }
  };

  return (
    <div className="w-full max-w-7xl mx-auto px-2 sm:px-4 py-2 space-y-3 select-none">
      {/* =========================================================================
          1. TOP BAR: [History] [Rules] [Real Balance: 2,340.50 EGP] [+] [Deposit]
          ========================================================================= */}
      <div className="bg-[#0e1929] border border-[#1e293b] rounded-2xl p-2.5 sm:px-4 flex items-center justify-between gap-3 shadow-lg text-white">
        {/* Left: Buttons for History & Rules */}
        <div className="flex items-center gap-2">
          {/* History Button ("السجل") */}
          <button
            type="button"
            onClick={() => setIsHistoryModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#1e293b] hover:bg-[#334155] text-xs font-bold text-[#E2E8F0] transition-colors cursor-pointer border border-white/5 shadow-xs"
          >
            <History className="w-3.5 h-3.5 text-[#F59E0B]" />
            <span>{isAr ? 'السجل' : 'History'}</span>
          </button>

          {/* Rules Button ("الأحكام والشروط") */}
          <button
            type="button"
            onClick={() => setIsRulesOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#1e293b] hover:bg-[#334155] text-xs font-bold text-[#E2E8F0] transition-colors cursor-pointer border border-white/5 shadow-xs"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#38BDF8]" />
            <span>{isAr ? 'الأحكام والشروط' : 'Rules'}</span>
          </button>
        </div>

        {/* Right: Currency Balance Display + Green Deposit Button [+] */}
        <div className="flex items-center gap-2">
          {/* Real Balance display e.g. "2,340.50 ج.م" */}
          <div className="flex items-center gap-2 bg-[#0a111c] px-3.5 py-1.5 rounded-xl border border-white/10 font-mono text-sm font-black text-white">
            <span className="text-xs text-[#94A3B8] font-sans font-bold">
              {isAr ? 'الرصيد:' : 'Balance:'}
            </span>
            <span className="text-base font-black text-[#10B981]">
              {user.balance.toFixed(2)}
            </span>
            <span className="text-xs text-[#F59E0B] font-sans font-bold">{currencySymbol}</span>
          </div>

          {/* Green Deposit Button [+] */}
          <button
            type="button"
            onClick={() => {
              if (onOpenDepositModal) {
                onOpenDepositModal();
              } else {
                setIsDepositOpen(true);
              }
            }}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#10B981] hover:bg-[#059669] text-white font-black text-xs transition-all shadow-md active:scale-95 cursor-pointer"
            title={isAr ? 'إيداع رصيد جديد' : 'Deposit funds'}
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            <span className="hidden sm:inline">{isAr ? 'إيداع' : 'Deposit'}</span>
          </button>
        </div>
      </div>

      {/* =========================================================================
          2. LAST 10 CRASH POINTS HISTORY BAR
          - Styled with: blue for <2x, purple for 2x-10x, gold for >10x
          ========================================================================= */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1.5 px-2 bg-[#0a111c] rounded-2xl border border-[#1e293b]">
        <div className="flex items-center gap-1.5 shrink-0 text-[11px] font-bold text-[#94A3B8] ps-1">
          <History className="w-3.5 h-3.5 text-[#F59E0B]" />
          <span>{isAr ? 'آخر 10 جولات:' : 'Last 10 Rounds:'}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-1 overflow-x-auto no-scrollbar">
          {history.slice(0, 10).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedHistoryItem(item)}
              className={`px-2.5 py-1 rounded-xl border text-xs font-mono whitespace-nowrap cursor-pointer transition-all hover:scale-105 ${getMultiplierBadgeStyle(
                item.multiplier
              )}`}
              title={`${item.hash} - Click to verify fairness`}
            >
              {item.multiplier.toFixed(2)}x
            </button>
          ))}
        </div>
      </div>

      {/* =========================================================================
          3. 1XBET DARK THEME CANVAS ARENA
          - Dark navy background (#0e1929)
          - Grid lines
          - Smooth Bezier curve (ctx.bezierCurveTo)
          - Glowing yellow jet airplane
          ========================================================================= */}
      <div className="w-full bg-[#0e1929] border border-[#1e293b] rounded-3xl overflow-hidden relative shadow-2xl min-h-[350px] sm:min-h-[430px] flex flex-col justify-between">
        {/* Top Info inside screen */}
        <div className="p-3 sm:p-4 flex items-center justify-between z-10 pointer-events-none">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-xl bg-black/60 backdrop-blur-md text-[#94A3B8] border border-white/10 text-[11px] font-mono flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
              <span className="truncate max-w-[130px] sm:max-w-[200px]">{currentRoundHash}</span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-xl bg-[#F59E0B]/15 border border-[#F59E0B]/30 text-[#F59E0B] text-xs font-black tracking-wide flex items-center gap-1 uppercase">
              <Zap className="w-3.5 h-3.5 fill-current" />
              <span>Aviator Live</span>
            </span>
          </div>
        </div>

        {/* Center / Right Huge Multiplier Counter */}
        <div className="absolute inset-0 flex flex-col items-center sm:items-end justify-center pointer-events-none z-10 px-4 sm:px-14 text-center sm:text-end">
          {gameState === 'WAITING' && (
            <div className="w-full flex flex-col items-center justify-center space-y-2.5 animate-in zoom-in duration-200">
              <span className="text-xs sm:text-sm font-bold text-[#94A3B8] uppercase tracking-wider">
                {isAr ? 'تبدأ الرحلة القادمة خلال' : 'NEXT FLIGHT STARTS IN'}
              </span>
              <div className="text-6xl sm:text-7xl font-black font-mono text-[#F59E0B] tracking-tight">
                {countdown.toFixed(1)}s
              </div>
              <div className="w-56 sm:w-72 h-2.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#F59E0B] to-[#EF4444] transition-all duration-100"
                  style={{ width: `${(countdown / 5.0) * 100}%` }}
                />
              </div>
            </div>
          )}

          {gameState === 'FLYING' && (
            <div className="space-y-1 animate-in zoom-in-95 pe-2 sm:pe-8">
              {/* Giant Multiplier Counter (e.g. 2.45x) */}
              <div className="text-7xl sm:text-8xl lg:text-9xl font-black font-mono tracking-tighter text-white drop-shadow-[0_12px_36px_rgba(255,255,255,0.35)]">
                {multiplier.toFixed(2)}
                <span className="text-4xl sm:text-6xl text-[#F59E0B] font-bold">x</span>
              </div>
              <span className="text-xs sm:text-sm font-black text-[#F59E0B] animate-pulse block uppercase tracking-wider text-center sm:text-end drop-shadow-[0_2px_10px_rgba(245,158,11,0.5)]">
                {isAr ? 'الطائرة في الجو... اجمع أرباحك الآن!' : 'Plane is flying... Cash out now!'}
              </span>
            </div>
          )}

          {gameState === 'CRASHED' && (
            <div className="w-full flex flex-col items-center justify-center space-y-3 animate-in zoom-in duration-150 text-center">
              <div className="px-6 py-2.5 rounded-2xl bg-[#EF4444]/20 border border-[#EF4444]/80 backdrop-blur-md shadow-2xl flex items-center gap-2.5">
                <span className="w-3 h-3 rounded-full bg-[#EF4444] animate-ping" />
                <span className="text-2xl sm:text-4xl font-black text-[#EF4444] tracking-wide uppercase drop-shadow-[0_0_18px_rgba(239,68,68,0.85)]">
                  {isAr ? 'طارت الطائرة! (FLEW AWAY)' : 'FLEW AWAY! CRASHED'}
                </span>
              </div>
              <div className="text-6xl sm:text-8xl font-black font-mono text-white drop-shadow-[0_8px_25px_rgba(239,68,68,0.6)]">
                {multiplier.toFixed(2)}
                <span className="text-4xl sm:text-6xl text-[#EF4444]">x</span>
              </div>
              <span className="text-xs font-mono font-bold text-[#CBD5E1] bg-black/60 px-3.5 py-1.5 rounded-xl border border-white/10">
                {isAr ? 'الجولة التالية تبدأ خلال 3 ثوانٍ...' : 'Next round starts in 3 seconds...'}
              </span>
            </div>
          )}
        </div>

        {/* HTML5 Canvas with 1xBet Navy Grid & Glowing Jet */}
        <canvas
          ref={canvasRef}
          width={900}
          height={420}
          className="w-full h-full object-cover flex-1"
        />
      </div>

      {/* =========================================================================
          4. DUAL REAL-BALANCE BETTING PANELS (لوحتا الرهان المزدوج)
          - Prominent "Cash Out / Collect Winnings" button
          - Live calculated profit and payout based on real currency
          ========================================================================= */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Betting Panel 1 */}
        <BetPanelCard
          slotIndex={1}
          betState={bet1}
          onChangeBetState={setBet1}
          gameState={gameState}
          currentMultiplier={multiplier}
          currencySymbol={currencySymbol}
          onToggleBet={() => handleToggleBet(1)}
          onCashout={() => executeCashout(1)}
          isAr={isAr}
        />

        {/* Betting Panel 2 */}
        <BetPanelCard
          slotIndex={2}
          betState={bet2}
          onChangeBetState={setBet2}
          gameState={gameState}
          currentMultiplier={multiplier}
          currencySymbol={currencySymbol}
          onToggleBet={() => handleToggleBet(2)}
          onCashout={() => executeCashout(2)}
          isAr={isAr}
        />
      </div>

      {/* =========================================================================
          5. LIVE STATS BAR UNDER BET BUTTONS
          ========================================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 p-3 sm:p-4 bg-[#0e1929] border border-[#1e293b] rounded-2xl text-white shadow-sm">
        {/* Stat 1: عدد الرهانات */}
        <div className="flex items-center gap-3 p-2 bg-[#132238]/60 rounded-xl border border-white/5">
          <div className="w-10 h-10 rounded-xl bg-[#38BDF8]/15 text-[#38BDF8] flex items-center justify-center shrink-0">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] font-bold text-[#94A3B8] block">
              {isAr ? 'عدد الرهانات النشطة' : 'Total Bets Placed'}
            </span>
            <span className="font-mono text-base font-black text-white">
              {totalBetsCount.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Stat 2: مجموع الرهانات */}
        <div className="flex items-center gap-3 p-2 bg-[#132238]/60 rounded-xl border border-white/5">
          <div className="w-10 h-10 rounded-xl bg-[#F59E0B]/15 text-[#F59E0B] flex items-center justify-center shrink-0">
            <Coins className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] font-bold text-[#94A3B8] block">
              {isAr ? 'حجم الرهانات الحالية' : 'Total Bets Volume'}
            </span>
            <span className="font-mono text-base font-black text-[#F59E0B]">
              {totalBetsAmount.toLocaleString()} {currencySymbol}
            </span>
          </div>
        </div>

        {/* Stat 3: مجموع الأرباح المسحوبة */}
        <div className="flex items-center gap-3 p-2 bg-[#132238]/60 rounded-xl border border-white/5">
          <div className="w-10 h-10 rounded-xl bg-[#10B981]/15 text-[#10B981] flex items-center justify-center shrink-0">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] font-bold text-[#94A3B8] block">
              {isAr ? 'مجموع أرباح اللاعبين' : 'Total Player Profits'}
            </span>
            <span className="font-mono text-base font-black text-[#10B981]">
              +{totalProfitAmount.toLocaleString()} {currencySymbol}
            </span>
          </div>
        </div>
      </div>

      {/* =========================================================================
          6. LIVE PARTICIPANTS TABLE
          ========================================================================= */}
      <div className="bg-[#0e1929] border border-[#1e293b] rounded-2xl p-4 text-white shadow-md space-y-3">
        <div className="flex items-center justify-between border-b border-[#1e293b] pb-2.5">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-[#F59E0B]" />
            <h3 className="text-sm font-black">
              {isAr ? 'جدول المشاركين الحي في الجولة' : 'Live Round Participants'}
            </h3>
          </div>
          <span className="text-xs font-mono text-[#94A3B8] bg-black/40 px-2.5 py-1 rounded-lg border border-white/5">
            {participants.length + (bet1.isPlaced ? 1 : 0) + (bet2.isPlaced ? 1 : 0)}{' '}
            {isAr ? 'لاعب' : 'players'}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead>
              <tr className="border-b border-[#1e293b] text-[#94A3B8]">
                <th className="py-2.5 px-3 text-start font-bold">
                  {isAr ? 'اسم المستخدم' : 'Username'}
                </th>
                <th className="py-2.5 px-3 text-center font-bold">
                  {isAr ? 'الفرص' : 'Odds'}
                </th>
                <th className="py-2.5 px-3 text-end font-bold">
                  {isAr ? 'الرهان' : 'Bet'}
                </th>
                <th className="py-2.5 px-3 text-end font-bold">
                  {isAr ? 'الأرباح' : 'Profit'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293b]/60 font-mono">
              {/* User Bet 1 */}
              {bet1.isPlaced && (
                <tr className="bg-[#F59E0B]/10 text-white font-bold">
                  <td className="py-2.5 px-3 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#F59E0B] animate-ping" />
                    <span>
                      {user.phoneNumber ? user.phoneNumber.slice(0, 4) + '****' : (isAr ? 'رهانك #1' : 'Your Bet #1')}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    {bet1.cashedOut ? (
                      <span className="px-2 py-0.5 rounded bg-[#10B981]/20 text-[#10B981] font-black">
                        {bet1.cashoutMultiplier?.toFixed(2)}x
                      </span>
                    ) : (
                      <span className="text-[#94A3B8]">-</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-end text-white">
                    {bet1.amount.toFixed(1)} {currencySymbol}
                  </td>
                  <td className="py-2.5 px-3 text-end">
                    {bet1.cashedOut ? (
                      <span className="text-[#10B981] font-black">
                        +{bet1.payout?.toFixed(1)} {currencySymbol}
                      </span>
                    ) : gameState === 'CRASHED' ? (
                      <span className="text-[#EF4444]">0.0 {currencySymbol}</span>
                    ) : (
                      <span className="text-[#94A3B8]">...</span>
                    )}
                  </td>
                </tr>
              )}

              {/* User Bet 2 */}
              {bet2.isPlaced && (
                <tr className="bg-[#F59E0B]/10 text-white font-bold">
                  <td className="py-2.5 px-3 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#F59E0B] animate-ping" />
                    <span>
                      {user.phoneNumber ? user.phoneNumber.slice(0, 4) + '****' : (isAr ? 'رهانك #2' : 'Your Bet #2')}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    {bet2.cashedOut ? (
                      <span className="px-2 py-0.5 rounded bg-[#10B981]/20 text-[#10B981] font-black">
                        {bet2.cashoutMultiplier?.toFixed(2)}x
                      </span>
                    ) : (
                      <span className="text-[#94A3B8]">-</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-end text-white">
                    {bet2.amount.toFixed(1)} {currencySymbol}
                  </td>
                  <td className="py-2.5 px-3 text-end">
                    {bet2.cashedOut ? (
                      <span className="text-[#10B981] font-black">
                        +{bet2.payout?.toFixed(1)} {currencySymbol}
                      </span>
                    ) : gameState === 'CRASHED' ? (
                      <span className="text-[#EF4444]">0.0 {currencySymbol}</span>
                    ) : (
                      <span className="text-[#94A3B8]">...</span>
                    )}
                  </td>
                </tr>
              )}

              {/* Bot Participants */}
              {participants.map((bot) => (
                <tr key={bot.id} className="hover:bg-[#132238]/40 transition-colors">
                  <td className="py-2.5 px-3 text-[#E2E8F0] font-sans font-bold flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-black/40 overflow-hidden shrink-0 border border-white/5">
                      <img src={bot.avatar} alt={bot.name} className="w-full h-full object-cover" />
                    </div>
                    <span>{bot.name}</span>
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    {bot.cashedOut ? (
                      <span className="px-2 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] font-black">
                        {bot.cashoutMultiplier?.toFixed(2)}x
                      </span>
                    ) : (
                      <span className="text-[#64748B]">-</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-end text-white">
                    {bot.betAmount.toFixed(1)} {currencySymbol}
                  </td>
                  <td className="py-2.5 px-3 text-end">
                    {bot.cashedOut ? (
                      <span className="text-[#10B981] font-black">
                        +{bot.profit?.toFixed(1)} {currencySymbol}
                      </span>
                    ) : gameState === 'CRASHED' ? (
                      <span className="text-[#EF4444]">0.0 {currencySymbol}</span>
                    ) : (
                      <span className="text-[#64748B]">...</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Deposit Modal */}
      <DepositModal
        isOpen={isDepositOpen}
        onClose={() => setIsDepositOpen(false)}
        user={user}
        settings={storage.getSettings()}
        onDepositSuccess={() => {
          onUpdateUser(storage.getUser());
        }}
        onShowNotification={onShowNotification}
      />

      {/* Rules Modal */}
      <RulesModal isOpen={isRulesOpen} onClose={() => setIsRulesOpen(false)} />

      {/* Provably Fair History Modal */}
      {(isHistoryModalOpen || selectedHistoryItem) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-md bg-[#0e1929] border border-[#1e293b] rounded-3xl p-6 text-white space-y-4">
            <div className="flex items-center justify-between border-b border-[#1e293b] pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#10B981]" />
                <h3 className="text-base font-black">
                  {isAr ? 'سجل وعدالة جولات الطائرة' : 'Aviator Provably Fair'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsHistoryModalOpen(false);
                  setSelectedHistoryItem(null);
                }}
                className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center font-mono cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="p-3 bg-[#132238]/60 rounded-xl border border-white/5 flex items-center justify-between text-xs font-mono"
                >
                  <div>
                    <span className="text-[10px] text-[#94A3B8] block">#{item.id}</span>
                    <span className="text-[#38BDF8] truncate max-w-[160px] block text-[10px]">
                      {item.hash}
                    </span>
                  </div>
                  <div className="text-end">
                    <span className={`text-base font-black ${item.multiplier >= 10 ? 'text-[#FDE047]' : item.multiplier >= 2 ? 'text-[#C084FC]' : 'text-[#38BDF8]'}`}>
                      {item.multiplier.toFixed(2)}x
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => {
                setIsHistoryModalOpen(false);
                setSelectedHistoryItem(null);
              }}
              className="w-full py-2.5 rounded-xl bg-[#F59E0B] text-black font-extrabold text-xs cursor-pointer hover:bg-[#D97706] transition-colors"
            >
              {isAr ? 'إغلاق' : 'Close'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// =========================================================================
// REUSABLE BET PANEL COMPONENT (لوحة الرهان)
// - Real Money Payout & Calculated Net Profit
// - Prominent "Cash Out / Collect Winnings" button
// =========================================================================
interface BetPanelCardProps {
  slotIndex: 1 | 2;
  betState: BetSlotState;
  onChangeBetState: React.Dispatch<React.SetStateAction<BetSlotState>>;
  gameState: CrashGameState;
  currentMultiplier: number;
  currencySymbol: string;
  onToggleBet: () => void;
  onCashout: () => void;
  isAr: boolean;
}

const BetPanelCard: React.FC<BetPanelCardProps> = ({
  slotIndex,
  betState,
  onChangeBetState,
  gameState,
  currentMultiplier,
  currencySymbol,
  onToggleBet,
  onCashout,
  isAr,
}) => {
  const currentLivePayout = Number((betState.amount * currentMultiplier).toFixed(2));
  const currentLiveProfit = Number(Math.max(0, currentLivePayout - betState.amount).toFixed(2));
  const quickAmounts = [10, 50, 100, 400, 1000, 5000];

  return (
    <div className="bg-[#0e1929] border border-[#1e293b] rounded-3xl p-3.5 sm:p-4 shadow-xl text-white space-y-3">
      {/* Top Header Row: Auto Play Toggle + Auto Cashout */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e293b] pb-2.5">
        {/* Auto Play Toggle */}
        <button
          type="button"
          onClick={() =>
            onChangeBetState((prev) => ({ ...prev, autoPlayEnabled: !prev.autoPlayEnabled }))
          }
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
            betState.autoPlayEnabled
              ? 'bg-[#10B981] text-black border-[#10B981] shadow-xs'
              : 'bg-[#132238] text-[#94A3B8] hover:text-white border-white/5'
          }`}
        >
          {betState.autoPlayEnabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          <span>
            {isAr
              ? betState.autoPlayEnabled
                ? 'تشغيل تلقائي: مفعّل'
                : 'تمكين التشغيل التلقائي'
              : betState.autoPlayEnabled
              ? 'Auto Play: Active'
              : 'Enable Auto Play'}
          </span>
        </button>

        {/* Auto Cashout Config */}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-[#CBD5E1]">
            <input
              type="checkbox"
              checked={betState.autoCashoutEnabled}
              onChange={(e) =>
                onChangeBetState((prev) => ({ ...prev, autoCashoutEnabled: e.target.checked }))
              }
              className="w-4 h-4 accent-[#F59E0B] rounded cursor-pointer"
            />
            <span className="text-[11px] font-bold">
              {isAr ? 'سحب تلقائي' : 'Auto Cashout'}
            </span>
          </label>

          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.1"
              min="1.05"
              max="100"
              disabled={!betState.autoCashoutEnabled}
              value={betState.autoCashoutValue}
              onChange={(e) =>
                onChangeBetState((prev) => ({
                  ...prev,
                  autoCashoutValue: Math.max(1.05, parseFloat(e.target.value) || 2.0),
                }))
              }
              className={`w-16 px-2 py-1 bg-black/70 border rounded-xl font-mono text-xs font-bold text-center focus:outline-none ${
                betState.autoCashoutEnabled
                  ? 'border-[#F59E0B] text-[#F59E0B]'
                  : 'border-[#334155] text-[#64748B]'
              }`}
            />
            <span className="font-mono text-xs font-bold text-[#94A3B8]">x</span>
          </div>
        </div>
      </div>

      {/* Middle Row: Amount Input with Clear (X) & Quick Chips */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-[#94A3B8]">
          <span className="font-bold">
            {isAr ? `مبلغ الرهان (${currencySymbol})` : `Bet Amount (${currencySymbol})`}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={betState.isPlaced}
              onClick={() =>
                onChangeBetState((prev) => ({
                  ...prev,
                  amount: Math.max(10, Math.floor(prev.amount / 2)),
                }))
              }
              className="px-2 py-0.5 rounded bg-[#132238] hover:bg-[#1e293b] text-[10px] font-mono cursor-pointer border border-white/5"
            >
              ½
            </button>
            <button
              type="button"
              disabled={betState.isPlaced}
              onClick={() =>
                onChangeBetState((prev) => ({
                  ...prev,
                  amount: Math.min(50000, prev.amount * 2),
                }))
              }
              className="px-2 py-0.5 rounded bg-[#132238] hover:bg-[#1e293b] text-[10px] font-mono cursor-pointer border border-white/5"
            >
              2X
            </button>
          </div>
        </div>

        <div className="relative">
          <input
            type="number"
            min={10}
            max={50000}
            disabled={betState.isPlaced}
            value={betState.amount || ''}
            onChange={(e) =>
              onChangeBetState((prev) => ({
                ...prev,
                amount: Math.max(0, parseFloat(e.target.value) || 0),
              }))
            }
            className="w-full ps-4 pe-16 py-2.5 bg-black/60 border border-[#1e293b] rounded-2xl font-mono text-base font-bold text-white focus:outline-none focus:border-[#F59E0B]"
          />

          {betState.amount > 0 && !betState.isPlaced && (
            <button
              type="button"
              onClick={() => onChangeBetState((prev) => ({ ...prev, amount: 0 }))}
              className="absolute end-12 top-1/2 -translate-y-1/2 p-1 text-[#94A3B8] hover:text-white rounded-full transition-colors cursor-pointer"
              title={isAr ? 'مسح' : 'Clear'}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          <span className="absolute end-3 top-1/2 -translate-y-1/2 font-mono text-xs font-bold text-[#F59E0B]">
            {currencySymbol}
          </span>
        </div>

        {/* Quick Chips Grid: [10] [50] [100] [400] [1000] [5000] */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 pt-0.5">
          {quickAmounts.map((q) => (
            <button
              key={q}
              type="button"
              disabled={betState.isPlaced}
              onClick={() => onChangeBetState((prev) => ({ ...prev, amount: q }))}
              className={`py-2 px-1 rounded-xl text-xs font-mono font-black border transition-all cursor-pointer ${
                betState.amount === q
                  ? 'bg-[#F59E0B] text-black border-[#F59E0B] shadow-xs scale-102'
                  : 'bg-[#132238]/70 border-white/5 text-[#CBD5E1] hover:text-white hover:border-[#F59E0B]/50'
              }`}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* =========================================================================
          PROMINENT CASH OUT / COLLECT WINNINGS BUTTON
          - Shows real-time calculated profit based on active balance
          ========================================================================= */}
      <div className="pt-1">
        {/* ACTIVE BET & PLANE FLYING -> PROMINENT CASH OUT BUTTON */}
        {betState.isPlaced && !betState.cashedOut && gameState === 'FLYING' ? (
          <button
            type="button"
            onClick={onCashout}
            className="w-full min-h-[64px] py-3 bg-gradient-to-r from-[#10B981] via-[#059669] to-[#047857] hover:from-[#059669] hover:to-[#065F46] text-white font-black rounded-2xl shadow-[0_0_30px_rgba(16,185,129,0.55)] transition-all cursor-pointer flex flex-col items-center justify-center leading-tight active:scale-[0.99] animate-pulse border-2 border-[#34D399]"
          >
            <div className="flex items-center gap-2">
              <ArrowUpRight className="w-5 h-5 text-white stroke-[3]" />
              <span className="text-xl sm:text-2xl font-black tracking-wide uppercase drop-shadow-[0_2px_4px_rgba(0,0,0,0.4)]">
                {isAr ? 'سحب الأرباح الآن' : 'CASH OUT NOW'}
              </span>
            </div>
            <div className="flex items-center gap-2 font-mono text-sm sm:text-base font-extrabold text-[#D1FAE5] pt-0.5">
              <span>
                {currentLivePayout.toFixed(2)} {currencySymbol}
              </span>
              <span className="text-xs bg-black/40 px-2 py-0.5 rounded-lg text-[#FDE047]">
                {isAr ? `(ربح: +${currentLiveProfit.toFixed(2)} ${currencySymbol})` : `(+${currentLiveProfit.toFixed(2)} Profit)`}
              </span>
              <span className="text-xs text-white/90">
                @{currentMultiplier.toFixed(2)}x
              </span>
            </div>
          </button>
        ) : betState.isPlaced && betState.cashedOut ? (
          /* Already Cashed Out */
          <div className="w-full min-h-[60px] py-3 bg-[#10B981]/20 border border-[#10B981] text-[#34D399] font-black text-center rounded-2xl flex flex-col items-center justify-center leading-tight">
            <span className="text-sm font-bold uppercase">{isAr ? 'تم سحب الأرباح بنجاح!' : 'CASHED OUT!'}</span>
            <span className="font-mono text-base font-extrabold text-white">
              +{betState.payout?.toFixed(2)} {currencySymbol}{' '}
              <span className="text-xs text-[#FDE047]">@{betState.cashoutMultiplier?.toFixed(2)}x</span>
            </span>
          </div>
        ) : betState.isPlaced && gameState === 'CRASHED' ? (
          /* Crashed */
          <div className="w-full min-h-[60px] py-3 bg-[#EF4444]/20 border border-[#EF4444] text-[#F87171] font-black text-center rounded-2xl flex flex-col items-center justify-center leading-tight">
            <span className="text-sm">{isAr ? 'طارت الطائرة (خسارة الرهان)' : 'FLEW AWAY (LOST)'}</span>
            <span className="font-mono text-sm text-white/80">
              {betState.amount} {currencySymbol}
            </span>
          </div>
        ) : betState.isPlaced && gameState === 'WAITING' ? (
          /* Bet Placed, Waiting for next flight -> Cancel Button */
          <button
            type="button"
            onClick={onToggleBet}
            className="w-full min-h-[60px] py-3 bg-[#DC2626] hover:bg-[#B91C1C] text-white font-black text-base rounded-2xl shadow-md transition-all cursor-pointer flex flex-col items-center justify-center leading-tight"
          >
            <span>{isAr ? 'إلغاء الرهان (استرجاع المبلغ)' : 'CANCEL BET (REFUND)'}</span>
            <span className="font-mono text-xs opacity-80 pt-0.5">
              {betState.amount} {currencySymbol}
            </span>
          </button>
        ) : (
          /* Place Bet Button */
          <button
            type="button"
            onClick={onToggleBet}
            className={`w-full min-h-[60px] py-3 font-black text-base sm:text-lg rounded-2xl shadow-lg transition-all flex flex-col items-center justify-center leading-tight cursor-pointer active:scale-[0.99] ${
              gameState === 'WAITING'
                ? 'bg-gradient-to-r from-[#F59E0B] via-[#EA580C] to-[#D97706] hover:from-[#D97706] hover:to-[#C2410C] text-black font-black'
                : 'bg-gradient-to-r from-[#D97706] to-[#B45309] text-black opacity-80'
            }`}
          >
            <span>
              {isAr ? 'وضع الرهان' : 'Place Bet'}
            </span>
            <span className="font-mono text-xs text-black/80 font-bold pt-0.5">
              {betState.amount} {currencySymbol}
            </span>
          </button>
        )}
      </div>
    </div>
  );
};
