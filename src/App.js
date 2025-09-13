import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Modal, Pressable, Keyboard,
  Platform, KeyboardAvoidingView, ScrollView, useWindowDimensions, Image,
  Animated, Easing
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import * as SQLite from 'expo-sqlite';
import * as Localization from 'expo-localization';
import Constants from 'expo-constants';
import { Calendar } from 'react-native-calendars';
import { StatusBar } from 'expo-status-bar';

/* -------- Notifications: foreground presentation (new API) -------- */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/* -------- Light theme only -------- */
const T = {
  bg: '#F6F7FB',
  headerBg: '#F0F3FF',
  card: '#FFFFFF',
  text: '#0F172A',
  muted: '#64748B',
  primary: '#4F46E5',
  fieldBg: '#EEF2FF',
  border: '#E5E7EB',
  shadow: 'rgba(15, 23, 42, 0.06)',
  bad: '#EF4444',
  warn: '#F59E0B',
  accent: '#6366F1',
  chipBg: '#E5E7EB',
};

const FREQS = ['One-time', 'Weekly', 'Monthly', 'Yearly'];

/* -------- Currency detection -------- */
const EU_EUR = new Set(['AT','BE','HR','CY','EE','FI','FR','DE','GR','IE','IT','LV','LT','LU','MT','NL','PT','SK','SI','ES']);
const REGION_TO_CCY = { US:'USD', CA:'CAD', MX:'MXN', BR:'BRL', AR:'ARS', CL:'CLP', CO:'COP', PE:'PEN',
  GB:'GBP', CH:'CHF', NO:'NOK', SE:'SEK', DK:'DKK', IS:'ISK', PL:'PLN', CZ:'CZK', HU:'HUF', RO:'RON', BG:'BGN',
  RU:'RUB', TR:'TRY', UA:'UAH', IN:'INR', PK:'PKR', BD:'BDT', LK:'LKR', NP:'NPR',
  CN:'CNY', JP:'JPY', KR:'KRW', SG:'SGD', HK:'HKD', TW:'TWD', MY:'MYR', ID:'IDR', TH:'THB', PH:'PHP', VN:'VND',
  AU:'AUD', NZ:'NZD', AE:'AED', SA:'SAR', QA:'QAR', KW:'KWD', BH:'BHD', OM:'OMR', JO:'JOD', IL:'ILS',
  ZA:'ZAR', NG:'NGN', KE:'KES', EG:'EGP', MA:'MAD', TN:'TND', GH:'GHS' };
const detectCurrency = () => {
  const region = Localization.region || (Localization.locale?.split('-')[1]) || 'US';
  if (EU_EUR.has(region)) return 'EUR';
  return REGION_TO_CCY[region] || 'USD';
};

/* -------- Helpers -------- */
const fmtMoney = (amt, curr) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: curr }).format(Number(amt)); }
  catch { return `${amt} ${curr}`; }
};
const isoLocal = (d) => new Date(d).toISOString();
const parseISO = (s) => new Date(s);
const daysInMonth = (y,m)=> new Date(y, m+1, 0).getDate();
const addMonths = (date, n) => { const d=new Date(date); const day=d.getDate(); d.setMonth(d.getMonth()+n,1); const m=d.getMonth(); d.setDate(Math.min(day, daysInMonth(d.getFullYear(), m))); return d; };
const addYears  = (date, n) => { const d=new Date(date); d.setFullYear(d.getFullYear()+n); return d; };
const defaultDue = () => { const d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0); return d; };
const computeNextDue = (r) => { const d = parseISO(r.dueISO); if (r.frequency==='Monthly') return addMonths(d,1); if (r.frequency==='Yearly') return addYears(d,1); return d; };

/* Calendar helpers */
const toYMD = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const fromYMD = (s) => {
  const [y,m,d] = s.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  dt.setHours(9,0,0,0);
  return dt;
};
const startOfToday = () => { const n=new Date(); n.setHours(0,0,0,0); return n; };
const daysUntil = (d) => {
  const a = startOfToday();
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b - a) / 86400000);
};

/* -------- DB -------- */
async function ensureTables(db) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT, amount REAL, currency TEXT,
      dueISO TEXT, frequency TEXT, notes TEXT,
      notificationId TEXT, createdAt TEXT
    );
  `);
}

/* -------- Notifications (typed triggers + strict perms) -------- */
async function ensureNotifPerm() {
  let settings = await Notifications.getPermissionsAsync();
  if (settings.status !== 'granted') {
    settings = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
  }
  if (settings.status !== 'granted' && settings.status !== 'provisional') {
    throw new Error('Notifications not allowed');
  }
}

const isExpoGo = Constants.appOwnership === 'expo';
// Custom sounds only work in a custom dev build or production build (not Expo Go).
const SOUND_MAIN = Platform.OS === 'ios' ? (isExpoGo ? 'default' : 'remind.caf') : (isExpoGo ? 'default' : 'remind');
const SOUND_ACK  = Platform.OS === 'ios' ? (isExpoGo ? 'default' : 'added.caf')  : (isExpoGo ? 'default' : 'added');

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('reminders', {
    name: 'Reminders',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 200, 120, 200],
    lightColor: '#2563EB',
    sound: SOUND_MAIN === 'default' ? 'default' : SOUND_MAIN, // name without extension for Android
    bypassDnd: false,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

/* Schedules: main reminder (date/weekly) OR quick 10s ack */
async function scheduleFor(rec) {
  await ensureNotifPerm();
  await ensureAndroidChannel();

  const due = parseISO(rec.dueISO);
  const now = new Date();
  const deltaSec = Math.max(1, Math.round((due - now) / 1000));
  const SHORT_WINDOW_SEC = 90;

  const content = {
    title: `💸 Payment due: ${rec.title}`,
    body: rec.amount ? `Amount: ${fmtMoney(rec.amount, rec.currency)}` : 'Due today',
    data: { id: rec.id },
    categoryIdentifier: 'dueActions',
    androidChannelId: 'reminders',
    sound: SOUND_MAIN,
    interruptionLevel: 'timeSensitive',
  };

  if (rec.frequency === 'Weekly') {
    const weekday = due.getDay() + 1; // 1..7
    return Notifications.scheduleNotificationAsync({
      content,
      trigger: { type: 'calendar', weekday, hour: due.getHours(), minute: due.getMinutes(), repeats: true },
    });
  }

  if (deltaSec <= SHORT_WINDOW_SEC) {
    return Notifications.scheduleNotificationAsync({
      content,
      trigger: { type: 'timeInterval', seconds: deltaSec, repeats: false },
    });
  }

  return Notifications.scheduleNotificationAsync({
    content,
    trigger: { type: 'date', date: due },
  });
}

/* 10-second “acknowledgement” after adding */
async function scheduleAck(rec) {
  await ensureNotifPerm();
  await ensureAndroidChannel();

  const when = 10; // seconds
  const content = {
    title: `✅ Saved: ${rec.title}`,
    body: rec.amount
      ? `Reminder added for ${fmtMoney(rec.amount, rec.currency)} on ${new Date(rec.dueISO).toLocaleDateString()}`
      : `Reminder added for ${new Date(rec.dueISO).toLocaleDateString()}`,
    data: { id: rec.id, ack: true },
    androidChannelId: 'reminders',
    sound: SOUND_ACK,
    interruptionLevel: 'timeSensitive',
  };

  return Notifications.scheduleNotificationAsync({
    content,
    trigger: { type: 'timeInterval', seconds: when, repeats: false },
  });
}

async function cancelNotif(id) { if (id) try { await Notifications.cancelScheduledNotificationAsync(id); } catch {} }

/* ======================= Toast system ======================= */
/* ======================= Toast system ======================= */
const ToastContext = React.createContext({ show: () => {}, hide: () => {} });
function useToast() { return React.useContext(ToastContext); }

function ToastProvider({ children }) {
  const [toast, setToast] = useState(null); // { type, title, message }
  const anim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef(null);

  // Make it responsive & safe-area aware
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Keep nice margins on any device; cap width for tablets/landscape
  const horizontalMargin = 12;
  const maxCardWidth = Math.min(520, width - horizontalMargin * 2);
  const topOffset = Math.max(insets.top, 10) + 8; // a small gap below notch/status bar

  const hide = () => {
    Animated.timing(anim, { toValue: 0, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true })
      .start(() => setToast(null));
  };

  const show = ({ type = 'info', title, message, duration = 2500 }) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setToast({ type, title, message });
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    hideTimer.current = setTimeout(hide, duration);
  };

  const bg =
    toast?.type === 'success' ? '#10B981' :
    toast?.type === 'error'   ? '#EF4444' :
    toast?.type === 'warn'    ? '#F59E0B' : T.primary;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] });
  const opacity = anim;

  return (
    <ToastContext.Provider value={{ show, hide }}>
      {children}

      {toast && (
        <Animated.View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: topOffset,
            alignItems: 'center',       // center on any width
            zIndex: 9999,
            transform: [{ translateY }],
            opacity,
          }}
        >
          <View
            style={{
              width: maxCardWidth,
              backgroundColor: bg,
              borderRadius: 14,
              paddingVertical: 12,
              paddingHorizontal: 14,
              shadowColor: '#000',
              shadowOpacity: 0.2,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 8 },
              elevation: 6,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
            accessibilityRole="alert"
            accessible
          >
            <Text style={{ color: '#fff', fontWeight: '800' }}>
              {toast.type === 'success' ? '✓' : toast.type === 'error' ? '!' : 'ℹ︎'}
            </Text>
            <View style={{ flex: 1 }}>
              {!!toast.title && (
                <Text
                  style={{ color: '#fff', fontWeight: '800' }}
                  numberOfLines={2}
                >
                  {toast.title}
                </Text>
              )}
              {!!toast.message && (
                <Text style={{ color: '#fff', opacity: 0.95 }}>
                  {toast.message}
                </Text>
              )}
            </View>
            <TouchableOpacity
              onPress={hide}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Dismiss"
              accessibilityRole="button"
            >
              <Text style={{ color: '#fff', fontWeight: '900' }}>×</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}


/* ======================= Root wrapper ======================= */
export default function App() {
  return (
   <SafeAreaProvider>
    <ToastProvider>
      <MainApp />
    </ToastProvider>
        </SafeAreaProvider>

  );
}

/* ======================= Main App ======================= */
function MainApp() {
  const toast = useToast();

  const { width } = useWindowDimensions();
  const scale = Math.min(width, 430) / 375; // iPhone 15 Pro base
  const font = (n) => Math.round(n * scale * 0.98);
  const pad  = (n) => Math.round(n * scale);

  const dbRef = useRef(null);
  const titleRef = useRef(null);
  const amountRef = useRef(null);

  const [dbReady, setDbReady] = useState(false);
  const [items, setItems] = useState([]);

  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [currency] = useState(detectCurrency());
  const [due, setDue] = useState(defaultDue());
  const [frequency, setFrequency] = useState('One-time');
  const [saving, setSaving] = useState(false);

  // calendar modal
  const [showCal, setShowCal] = useState(false);
  const [tempYMD, setTempYMD] = useState(toYMD(due));
  const [hasPickedDate, setHasPickedDate] = useState(false);

  // bottom-sheet confirm delete
  const [confirmItem, setConfirmItem] = useState(null);

  const blurInputs = () => {
    titleRef.current?.blur?.();
    amountRef.current?.blur?.();
    Keyboard.dismiss();
  };

  useEffect(() => {
    (async () => {
      const db = await SQLite.openDatabaseAsync('payments.db');
      dbRef.current = db;
      await ensureTables(db);
      await load(db);
      await rollForwardRecurring(db);
      setDbReady(true);
    })();

    Notifications.setNotificationCategoryAsync('dueActions', [
      { identifier: 'SNOOZE', buttonTitle: 'Snooze 1d' },
      { identifier: 'DELETE', buttonTitle: 'Delete', options: { isDestructive: true } },
    ]);

    const sub = Notifications.addNotificationResponseReceivedListener(async (resp) => {
      const action = resp.actionIdentifier;
      const { id } = resp.notification.request.content.data || {};
      if (!id) return;
      if (action === 'SNOOZE') await snoozeById(id, 1);
      if (action === 'DELETE') await handleRemove(id);
    });
    return () => sub.remove();
  }, []);

  const load = async (db) => {
    const rows = await db.getAllAsync('SELECT * FROM reminders ORDER BY dueISO ASC;');
    setItems(rows || []);
  };

  const upsert = async (db, r) => {
    await db.runAsync(
      `INSERT OR REPLACE INTO reminders
       (id,title,amount,currency,dueISO,frequency,notes,notificationId,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [r.id, r.title, r.amount ?? null, r.currency, r.dueISO, r.frequency, r.notes ?? null, r.notificationId ?? null, r.createdAt ?? new Date().toISOString()]
    );
    await load(db);
  };

  const handleRemove = async (id) => {
    const row = items.find(x => x.id === id) ||
                (await dbRef.current.getAllAsync('SELECT * FROM reminders WHERE id=?', [id]))?.[0];
    await cancelNotif(row?.notificationId);
    const db = dbRef.current;
    await db.runAsync('DELETE FROM reminders WHERE id=?', [id]);
    await load(db);
  };

  const snoozeById = async (id, days = 1) => {
    const db = dbRef.current;
    const row = (await db.getAllAsync('SELECT * FROM reminders WHERE id=?', [id]))?.[0];
    if (!row) return;
    await cancelNotif(row.notificationId);
    const d = parseISO(row.dueISO);
    d.setDate(d.getDate() + days);
    const updated = { ...row, dueISO: isoLocal(d) };
    const newId = await scheduleFor(updated);
    updated.notificationId = newId;
    await upsert(db, updated);
    toast.show({ type: 'success', title: 'Snoozed', message: `Moved to ${new Date(updated.dueISO).toLocaleDateString()}` });
  };

  const addItem = async () => {
    if (saving) return;
    setSaving(true);

    blurInputs();

    if (!title.trim()) {
      toast.show({ type: 'error', title: 'Missing info', message: 'Please enter a name for the payment.' });
      setSaving(false); return;
    }
    if (amount.trim() && isNaN(Number(amount))) {
      toast.show({ type: 'error', title: 'Invalid amount', message: 'Enter a valid number.' });
      setSaving(false); return;
    }

    const now = new Date();
    if (parseISO(isoLocal(due)) < now) {
      toast.show({ type: 'warn', title: 'Pick a future date', message: 'Please choose a future date.' });
      setSaving(false); return;
    }

    const db = dbRef.current;
    const rec = {
      id: Math.random().toString(36).slice(2),
      title: title.trim(),
      amount: amount.trim() ? Number(amount) : null,
      currency,
      dueISO: isoLocal(due),
      frequency,
      notes: null,
      createdAt: new Date().toISOString()
    };
    try {
      const notificationId = await scheduleFor(rec);
      rec.notificationId = notificationId;
      await upsert(db, rec);

      // schedule 10s acknowledgement
      await scheduleAck(rec);

      setTitle(''); setAmount(''); setDue(defaultDue()); setFrequency('One-time'); setHasPickedDate(false);
      toast.show({ type: 'success', title: 'Scheduled', message: 'Reminder added successfully.' });
    } catch {
      await upsert(db, rec);
      toast.show({ type: 'warn', title: 'Saved (no notification)', message: 'Check notification permissions.' });
    } finally {
      blurInputs();
      setSaving(false);
    }
  };

  const rollForwardRecurring = async (db) => {
    const arr = await db.getAllAsync('SELECT * FROM reminders;');
    const now = new Date();
    for (const r of arr) {
      const dueDate = parseISO(r.dueISO);
      if (dueDate < now && (r.frequency === 'Monthly' || r.frequency === 'Yearly')) {
        await cancelNotif(r.notificationId);
        let n = computeNextDue(r);
        while (n < now) n = r.frequency === 'Monthly' ? addMonths(n, 1) : addYears(n, 1);
        const updated = { ...r, dueISO: isoLocal(n) };
        const newId = await scheduleFor(updated);
        updated.notificationId = newId;
        await upsert(db, updated);
      }
    }
  };

  const s = makeStyles({ font, pad });

  return (
    <SafeAreaView style={[s.safeArea, { backgroundColor: T.bg }]}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={s.scrollContent}
        >
          {/* Header */}
          <View style={s.header}>
            <Image
              source={require('../assets/modernB-icon-1024.png')} // if App.js is in src/
              // source={require('./assets/modernB-icon-1024.png')} // if App.js is at project root
              style={s.headerLogo}
              resizeMode="contain"
              accessible
              accessibilityRole="image"
              accessibilityLabel="Remind Due app icon"
            />
            <Text style={[s.headerTitle, { color: T.text }]}>Remind Due</Text>
          </View>

          {/* Card: Add Payment */}
          <View style={[s.card, s.shadow]}>
            <Text style={[s.cardTitle, { color: T.text }]}>Add New Payment</Text>

            <View style={[s.field, { backgroundColor: T.fieldBg, borderColor: T.border }]}>
              <TextInput
                ref={titleRef}
                placeholder="Name (e.g., Rent, Gym, John)"
                placeholderTextColor={T.muted}
                value={title}
                onChangeText={setTitle}
                style={[s.input, { color: T.text }]}
                selectionColor={T.primary}
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => amountRef.current?.focus()}
              />
            </View>

            <View style={s.row}>
              <View style={[s.field, { flex: 1, backgroundColor: T.fieldBg, borderColor: T.border }]}>
                <TextInput
                  ref={amountRef}
                  placeholder="Amount"
                  placeholderTextColor={T.muted}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  style={[s.input, { color: T.text }]}
                  selectionColor={T.primary}
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={Keyboard.dismiss}
                />
              </View>
            </View>

            {/* Date button */}
            <TouchableOpacity
              onPress={() => { blurInputs(); setTempYMD(toYMD(due)); setShowCal(true); }}
              activeOpacity={0.9}
              accessibilityRole="button"
              accessibilityLabel="Pick date"
            >
              <View
                style={[
                  s.field,
                  s.btnField,
                  {
                    backgroundColor: T.fieldBg,
                    borderColor: T.border,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  },
                ]}
              >
                <Text style={[s.btnFieldText, { color: hasPickedDate ? T.text : T.muted }]}>
                  {hasPickedDate ? due.toLocaleDateString() : 'Pick Date'}
                </Text>
                <Text style={[s.btnFieldText, { color: T.text }]}>📅</Text>
              </View>
            </TouchableOpacity>

            {/* Frequency segmented chips */}
            <View style={s.segmentWrap}>
              {FREQS.map(f => {
                const active = frequency === f;
                return (
                  <TouchableOpacity
                    key={f}
                    onPress={() => setFrequency(f)}
                    activeOpacity={0.9}
                    style={[
                      s.segmentChip,
                      { backgroundColor: active ? T.primary : T.chipBg, borderColor: active ? T.primary : 'transparent' }
                    ]}
                  >
                    <Text style={[s.segmentText, { color: active ? '#fff' : T.text }]}>{f}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity onPress={addItem} style={[s.primaryBtn, { backgroundColor: T.primary }]} activeOpacity={0.9} disabled={saving}>
              <Text style={s.primaryBtnText}>{saving ? 'Saving…' : 'Add Payment'}</Text>
            </TouchableOpacity>
          </View>

          {/* Card: Upcoming */}
          <View style={[s.card, s.shadow]}>
            <Text style={[s.cardTitle, { color: T.text }]}>Your Upcoming Payments</Text>

            {!dbReady ? (
              <View style={{ paddingVertical: pad(16) }}><ActivityIndicator /></View>
            ) : items.length === 0 ? (
              <View style={[s.emptyBox, { borderColor: T.border, backgroundColor: T.fieldBg }]}>
                <Text style={[s.emptyText, { color: T.muted }]}>No upcoming payments</Text>
              </View>
            ) : (
              <FlatList
                data={items}
                keyExtractor={(i) => i.id}
                scrollEnabled={false}
                renderItem={({item}) => {
                  const d = parseISO(item.dueISO);
                  const du = daysUntil(d);
                  const label = du < 0 ? 'Overdue' : du <= 3 ? 'Soon' : null;
                  const labelStyle = du < 0
                    ? { backgroundColor: T.bad + '22', color: T.bad }
                    : du <= 3
                      ? { backgroundColor: T.warn + '22', color: T.warn }
                      : null;

                  return (
                    <View style={[s.itemCard, { borderColor: T.border, backgroundColor: T.card }]}>
                      <View style={s.itemHeader}>
                        <View style={{ flex: 1 }}>
                          <Text style={[s.itemTitle, { color: T.text }]} numberOfLines={1}>{item.title}</Text>
                          <Text style={[s.itemSub, { color: T.muted }]} numberOfLines={1}>
                            {d.toLocaleDateString()} • {item.frequency}
                          </Text>
                        </View>

                        <View style={{ alignItems:'flex-end' }}>
                          {!!item.amount && (
                            <Text style={[s.itemAmount, { color: T.accent }]} numberOfLines={1}>
                              {fmtMoney(item.amount, item.currency)}
                            </Text>
                          )}
                          <View style={s.itemActionsRow}>
                            {label && (
                              <View style={[s.badge, labelStyle]}>
                                <Text style={s.badgeText}>{label}</Text>
                              </View>
                            )}
                            <TouchableOpacity
                              onPress={() => setConfirmItem(item)}
                              style={[s.closeBtn, { borderColor: T.border, backgroundColor: T.fieldBg }]}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                              <Text style={[s.closeX, { color: T.text }]}>×</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      </View>
                    </View>
                  );
                }}
                contentContainerStyle={{ paddingTop: pad(6), paddingBottom: pad(8) }}
              />
            )}

            <Text style={[s.privacyNote, { color: T.muted }]}>🔒 Stored only on this device. Nothing is uploaded online.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Calendar Modal */}
      <Modal
        transparent
        visible={showCal}
        animationType="slide"
        onRequestClose={() => { setShowCal(false); setTimeout(blurInputs, 50); }}
      >
        <Pressable style={s.backdrop} onPress={() => { setShowCal(false); setTimeout(blurInputs, 50); }} />
        <View style={[s.sheet, { backgroundColor: T.card }]}>
          <Text style={[s.sheetTitle, { color: T.text }]}>Pick a date</Text>
          <Calendar
            initialDate={tempYMD}
            enableSwipeMonths
            onDayPress={(day) => setTempYMD(day.dateString)}
            markedDates={{ [tempYMD]: { selected: true, selectedColor: T.primary } }}
            theme={{
              textSectionTitleColor: T.muted,
              todayTextColor: T.primary,
              dayTextColor: T.text,
              monthTextColor: T.text,
              arrowColor: T.primary,
              selectedDayBackgroundColor: T.primary,
              selectedDayTextColor: '#fff',
            }}
            style={{ borderRadius: 12 }}
          />
          <View style={s.sheetActions}>
            <TouchableOpacity onPress={() => { setShowCal(false); setTimeout(blurInputs, 50); }} style={[s.sheetBtn, { backgroundColor: '#F3F4F6' }]}>
              <Text style={[s.sheetBtnText, { color: T.text }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                const picked = fromYMD(tempYMD);
                const today = new Date(); today.setHours(0,0,0,0);
                if (picked < today) {
                  toast.show({ type: 'warn', title: 'Past date', message: 'Please pick today or a future date.' });
                  return;
                }
                setDue(picked); setHasPickedDate(true);
                setShowCal(false); setTimeout(blurInputs, 50);
              }}
              style={[s.sheetBtn, { backgroundColor: T.primary }]}
            >
              <Text style={[s.sheetBtnText, { color: '#fff' }]}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Delete Confirm Bottom Sheet */}
      <Modal
        transparent
        visible={!!confirmItem}
        animationType="slide"
        onRequestClose={() => setConfirmItem(null)}
      >
        <Pressable style={s.backdrop} onPress={() => setConfirmItem(null)} />
        <View style={[s.sheet, { backgroundColor: T.card }]}>
          <Text style={[s.sheetTitle, { color: T.text }]}>Delete reminder?</Text>
          <Text style={{ color: T.muted, marginBottom: 12 }}>
            “{confirmItem?.title}” will be removed permanently.
          </Text>
          <View style={s.sheetActions}>
            <TouchableOpacity onPress={() => setConfirmItem(null)} style={[s.sheetBtn, { backgroundColor: '#F3F4F6' }]}>
              <Text style={[s.sheetBtnText, { color: T.text }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => {
                const id = confirmItem?.id;
                setConfirmItem(null);
                await handleRemove(id);
                toast.show({ type: 'success', title: 'Deleted', message: 'Reminder removed.' });
              }}
              style={[s.sheetBtn, { backgroundColor: T.bad }]}
            >
              <Text style={[s.sheetBtnText, { color: '#fff' }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* -------- dynamic styles for LIGHT UI -------- */
function makeStyles({ font, pad }) {
  return StyleSheet.create({
    safeArea: { flex: 1 },
    scrollContent: { paddingHorizontal: pad(18), paddingBottom: pad(24) },

    /* Header (with icon) */
    header: { flexDirection: 'row', alignItems: 'center', marginTop: pad(10), marginBottom: pad(18) },
    headerLogo: { width: 36, height: 36, borderRadius: 8, marginRight: 10 },
    headerTitle: { fontSize: font(26), fontWeight: '800', color: T.text },

    card: {
      backgroundColor: T.card,
      borderRadius: pad(22),
      padding: pad(18),
      marginBottom: pad(18),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: T.border,
    },
    shadow: {
      shadowColor: T.shadow,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.2,
      shadowRadius: 18,
      elevation: 6,
    },
    cardTitle: { fontSize: font(18), fontWeight: '700', marginBottom: pad(14), color: T.text },

    field: {
      borderRadius: pad(14),
      paddingHorizontal: pad(16),
      borderWidth: 1,
      marginBottom: pad(12),
      height: pad(52),
      justifyContent: 'center',
    },
    input: { height: pad(50), fontSize: font(16), color: T.text },
    row: { flexDirection: 'row', alignItems: 'center', gap: pad(10) },
    btnField: { height: pad(52), justifyContent: 'center' },
    btnFieldText: { fontSize: font(16), fontWeight: '600', color: T.text },

    segmentWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: pad(8),
      marginTop: pad(2),
      marginBottom: pad(6),
    },
    segmentChip: {
      paddingVertical: pad(10),
      paddingHorizontal: pad(14),
      borderRadius: 999,
      borderWidth: 1,
      backgroundColor: T.chipBg,
      borderColor: 'transparent',
    },
    segmentText: { fontWeight: '700', fontSize: font(14), color: T.text },

    primaryBtn: {
      borderRadius: pad(16),
      height: pad(56),
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: pad(12),
      shadowColor: T.primary,
      shadowOpacity: 0.25,
      shadowRadius: 12,
      shadowOffset: { height: 6, width: 0 },
      backgroundColor: T.primary,
    },
    primaryBtnText: { color: '#fff', fontSize: font(17), fontWeight: '800', letterSpacing: 0.2 },

    emptyBox: {
      borderWidth: 1,
      borderStyle: 'dashed',
      borderRadius: pad(18),
      paddingVertical: pad(26),
      alignItems: 'center',
      marginTop: pad(8),
      marginBottom: pad(4),
      backgroundColor: T.fieldBg,
      borderColor: T.border,
    },
    emptyText: { fontSize: font(15), fontStyle: 'italic', fontWeight: '600', color: T.muted },
    privacyNote: { fontSize: font(12), marginTop: pad(10), textAlign: 'center', color: T.muted },

    itemCard: {
      borderRadius: pad(16),
      padding: pad(14),
      borderWidth: 1,
      marginBottom: pad(10),
      backgroundColor: T.card,
      borderColor: T.border,
    },
    itemHeader: { flexDirection: 'row', alignItems: 'center' },
    itemTitle: { fontSize: font(16), fontWeight: '800', color: T.text },
    itemAmount: { fontSize: font(15), fontWeight: '700', color: T.accent },
    itemSub: { fontSize: font(12), marginTop: pad(2), color: T.muted },

    itemActionsRow: { flexDirection:'row', alignItems:'center', gap: pad(8), marginTop: pad(6) },
    badge: { paddingVertical: pad(4), paddingHorizontal: pad(8), borderRadius: 999 },
    badgeText: { fontWeight: '800', fontSize: font(11) },

    closeBtn: {
      width: pad(28), height: pad(28), borderRadius: 999,
      alignItems:'center', justifyContent:'center',
      borderWidth: 1,
      borderColor: T.border,
      backgroundColor: T.fieldBg,
    },
    closeX: { fontSize: font(18), lineHeight: font(18), fontWeight:'900', color: T.text },

    /* Bottom Sheet (shared) */
    backdrop: { position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.35)' },
    sheet: {
      position:'absolute', left:0, right:0, bottom:0,
      borderTopLeftRadius: pad(22), borderTopRightRadius: pad(22),
      padding: pad(16),
      maxHeight: '80%',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 20,
      shadowOffset: { width:0, height: -10 },
      elevation: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: T.border,
      backgroundColor: T.card,
    },
    sheetTitle: { fontSize: font(16), fontWeight:'800', marginBottom: pad(10), color: T.text },
    sheetActions: { flexDirection:'row', justifyContent:'flex-end', gap: pad(10), marginTop: pad(12) },
    sheetBtn: { paddingVertical: pad(10), paddingHorizontal: pad(14), borderRadius: pad(12) },
    sheetBtnText: { fontWeight:'800', fontSize: font(14) },
  });
}
