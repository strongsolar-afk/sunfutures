import React, { useMemo, useState, useRef, useEffect } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  Alert,
  Platform,
  KeyboardAvoidingView,
  Keyboard,
  TouchableWithoutFeedback,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import ViewShot, { captureRef } from "react-native-view-shot";
import MapView, { Marker, MapPressEvent } from "react-native-maps";
import * as Location from "expo-location";
import * as DocumentPicker from "expo-document-picker";
import Slider from "@react-native-community/slider";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  uploadEquipment,
  runForecast,
  runReport,
  UploadedFile,
  ForecastResp,
} from "./api";
import {
  VictoryAxis,
  VictoryChart,
  VictoryLine,
  VictoryTheme,
  VictoryTooltip,
  createContainer,
  VictoryArea,
  VictoryLegend,
} from "victory-native";

const ZoomVoronoiContainer = createContainer("zoom", "voronoi");

const PRESETS = [
  {
    id: "utility_sat_typical",
    name: "Utility SAT (typical)",
    mounting: "SAT" as const,
    plant: { gcr: 0.35, maxAngle: 60, backtracking: true },
    losses: {
      soiling: 2,
      snow: 0,
      mismatch: 1.5,
      dcWiring: 1.5,
      acWiring: 1.0,
      iam: 1.0,
      aux: 0.5,
      avail: 99.0,
    },
  },
  {
    id: "fixed_tilt_typical",
    name: "Fixed tilt (typical)",
    mounting: "FIXED" as const,
    plant: { gcr: 0.45, maxAngle: 0, backtracking: false, tilt: 25, azimuth: 180 },
    losses: {
      soiling: 2.5,
      snow: 0.5,
      mismatch: 1.5,
      dcWiring: 1.5,
      acWiring: 1.0,
      iam: 1.2,
      aux: 0.5,
      avail: 98.8,
    },
  },
  {
    id: "bifacial_desert",
    name: "Bifacial desert (typical)",
    mounting: "SAT" as const,
    plant: { gcr: 0.32, maxAngle: 60, backtracking: true, albedo: 0.28 },
    losses: {
      soiling: 3.0,
      snow: 0,
      mismatch: 1.5,
      dcWiring: 1.5,
      acWiring: 1.0,
      iam: 1.0,
      aux: 0.6,
      avail: 99.0,
    },
  },
];

const DEFAULT_EQUIPMENT_SETS = [
  {
    id: "maxeon_540_pe_central_sat",
    name: "Maxeon 540W + Central inverter + SAT",
    notes: "Upload PAN/OND to fully parameterize. This set just saves file refs + notes.",
    files: [] as UploadedFile[],
  },
];

const STEPS = [
  { id: "site", title: "Site", subtitle: "Pick a location on the map." },
  { id: "plant", title: "Plant", subtitle: "Sizing and mounting/tracker settings." },
  { id: "losses", title: "Losses", subtitle: "Derate sliders (defaults are typical)." },
  { id: "equipment", title: "Equipment", subtitle: "Upload PAN/OND or select a saved set." },
  { id: "review", title: "Review", subtitle: "Confirm inputs before running." },
  { id: "run", title: "Run", subtitle: "Generate forecast and share results." },
];

const styles = {
  screen: { flex: 1, backgroundColor: "#f9fafb" },
  h1: { fontSize: 24, fontWeight: "800" as const, marginBottom: 8 },
  sub: { color: "#6b7280", marginBottom: 14 },

  card: {
    backgroundColor: "white",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    marginBottom: 14,
  },
  cardTitle: { fontSize: 18, fontWeight: "800" as const },
  divider: { height: 1, backgroundColor: "#e5e7eb", marginVertical: 12 },

  row: { flexDirection: "row" as const, gap: 10, alignItems: "center" as const },
  label: { color: "#374151", fontWeight: "800" as const, marginBottom: 6 },
  help: { color: "#6b7280", fontSize: 12, marginTop: 6 },

  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "white",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: "#111827",
  },
  inputError: { borderColor: "#ef4444" },

  pill: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  pillActive: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  pillText: { fontWeight: "800" as const, color: "#111827" },
  pillTextActive: { color: "white" },

  fabBar: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    backgroundColor: "rgba(255,255,255,0.98)",
  },
  fabButton: {
    backgroundColor: "#111827",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center" as const,
  },
  fabButtonDisabled: { opacity: 0.5 },
  fabText: { color: "white", fontWeight: "900" as const, fontSize: 16 },

  errorText: { color: "#ef4444", marginTop: 6, fontWeight: "800" as const },
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <View style={styles.divider} />
      {children}
    </View>
  );
}

function Button({
  title,
  onPress,
  disabled,
  tone = "primary",
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "primary" | "secondary" | "danger";
}) {
  const bg =
    tone === "secondary" ? "white" : tone === "danger" ? "#dc2626" : "#111827";
  const border = tone === "secondary" ? "#e5e7eb" : bg;
  const text = tone === "secondary" ? "#111827" : "white";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: border,
        opacity: disabled ? 0.5 : 1,
        alignItems: "center",
      }}
    >
      <Text style={{ color: text, fontWeight: "900" }}>{title}</Text>
    </Pressable>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  error,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "numeric" | "decimal-pad" | "number-pad";
  error?: string | null;
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#9ca3af"
        keyboardType={keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, error ? styles.inputError : null]}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}


function StepHeader({
  step,
  total,
  title,
  subtitle,
}: {
  step: number;
  total: number;
  title: string;
  subtitle?: string;
}) {
  const dots = Array.from({ length: total }, (_, i) => i + 1);
  return (
    <View style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: "#6b7280", fontWeight: "800" }}>
          Step {step} of {total}
        </Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {dots.map((d) => (
            <View
              key={d}
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                backgroundColor: d === step ? "#111827" : "#d1d5db",
              }}
            />
          ))}
        </View>
      </View>

      <Text style={{ fontSize: 22, fontWeight: "900", marginTop: 6 }}>{title}</Text>
      {subtitle ? <Text style={{ color: "#6b7280", marginTop: 6 }}>{subtitle}</Text> : null}
    </View>
  );
}

function buildQuantiles(
  rows: { date: string; kwh: number }[],
  bands?: any
): { p10: any[]; p50: any[]; p90: any[]; from: "server" | "local" } {
  // Prefer backend probabilistic series if present
  if (bands?.series?.p10 && bands?.series?.p50 && bands?.series?.p90) {
    const toPts = (arr: any[]) =>
      arr.map((d: any, i: number) => ({ x: i + 1, y: d.kwh, label: `${d.date}\n${Math.round(d.kwh)} kWh` }));
    return { p10: toPts(bands.series.p10), p50: toPts(bands.series.p50), p90: toPts(bands.series.p90), from: "server" };
  }

  // Otherwise infer a widening uncertainty envelope around P50
  const p50 = rows.map((r, i) => ({
    x: i + 1,
    y: r.kwh,
    label: `${r.date}\n${Math.round(r.kwh)} kWh`,
  }));
  const p10 = rows.map((r, i) => {
    const widen = 0.10 + 0.20 * (i / Math.max(1, rows.length - 1));
    return { x: i + 1, y: Math.max(0, r.kwh * (1 - widen)), label: `${r.date}\nP10 ${Math.round(r.kwh * (1 - widen))} kWh` };
  });
  const p90 = rows.map((r, i) => {
    const widen = 0.10 + 0.20 * (i / Math.max(1, rows.length - 1));
    return { x: i + 1, y: r.kwh * (1 + widen), label: `${r.date}\nP90 ${Math.round(r.kwh * (1 + widen))} kWh` };
  });
  return { p10, p50, p90, from: "local" };
}

function ForecastChart({
  rows,
  bands,
}: {
  rows: { date: string; kwh: number }[];
  bands?: any;
}) {
  if (!rows.length) return null;
  const { p10, p50, p90, from } = buildQuantiles(rows, bands);

  const tickValues = rows
    .map((_, i) => i + 1)
    .filter((x) => x === 1 || x === rows.length || x % 5 === 1);

  const tickFormat = (x: number) => {
    const idx = Math.max(1, Math.min(rows.length, Math.round(x))) - 1;
    return (rows[idx]?.date ?? "").slice(5);
  };

  return (
    <View>
      <Text style={{ color: "#6b7280", marginBottom: 6 }}>
        Series: P50 (table) • Bands: P10/P90 ({from})
      </Text>

      <VictoryChart
        theme={VictoryTheme.material}
        height={260}
        padding={{ top: 16, left: 58, right: 22, bottom: 44 }}
        containerComponent={
          <ZoomVoronoiContainer
            zoomDimension="x"
            allowZoom
            allowPan
            minimumZoom={{ x: 6 }}
            labels={({ datum }: any) => datum.label}
            labelComponent={
              <VictoryTooltip
                flyoutPadding={{ top: 8, bottom: 8, left: 10, right: 10 }}
                cornerRadius={10}
              />
            }
          />
        }
      >
        <VictoryLegend
          x={70}
          y={0}
          orientation="horizontal"
          gutter={18}
          data={[
            { name: "P10–P90", symbol: { type: "square" } },
            { name: "P50", symbol: { type: "minus" } },
          ]}
        />

        <VictoryAxis tickValues={tickValues} tickFormat={tickFormat} />
        <VictoryAxis dependentAxis tickFormat={(y) => `${Math.round(y / 1000)}M`} />

        {/* Band fill */}
        <VictoryArea
          data={p90.map((d: any, i: number) => ({
            x: d.x,
            y: d.y,
            y0: p10[i]?.y ?? 0,
          }))}
          interpolation="monotoneX"
          style={{ data: { opacity: 0.18 } }}
        />

        {/* P50 */}
        <VictoryLine data={p50} interpolation="monotoneX" />
      </VictoryChart>
    </View>
  );
}

function formatNumber(n: number) {
  return Math.round(n).toLocaleString();
}

function toCsv(rows: { date: string; kwh: number }[]) {
  const header = "date,kwh\n";
  const body = rows.map((r) => `${r.date},${r.kwh}`).join("\n");
  return header + body + "\n";
}

async function shareTextFile(filename: string, content: string, mimeType: string) {
  const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!dir) throw new Error("No writable directory available");
  const path = dir + filename;
  await FileSystem.writeAsStringAsync(path, content, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert("Sharing not available", `Saved to: ${path}`);
    return;
  }
  await Sharing.shareAsync(path, { mimeType, dialogTitle: "Share SunFutures export" });
}

async function shareCsv(filename: string, csv: string) {
  return shareTextFile(filename, csv, "text/csv");
}

async function shareJson(filename: string, obj: any) {
  return shareTextFile(filename, JSON.stringify(obj, null, 2), "application/json");
}

async function sharePngFromRef(ref: any) {
  const uri = await captureRef(ref, { format: "png", quality: 1.0 });
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert("Sharing not available", `Image saved to: ${uri}`);
    return;
  }
  await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share SunFutures chart" });
}

export default function App() {
  const [mode, setMode] = useState<"wizard" | "advanced">("wizard");
  const [tab, setTab] = useState<"forecast" | "portfolio">("forecast");

  const [busy, setBusy] = useState(false);
  const [locBusy, setLocBusy] = useState(false);

  // Wizard step
  const [stepIdx, setStepIdx] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState(PRESETS[0].id);

  // Site
  const [siteName, setSiteName] = useState("");
  const [lat, setLat] = useState(36.1699);
  const [lon, setLon] = useState(-115.1398);
  const [elev, setElev] = useState("");

  // Plant
  const [plantName, setPlantName] = useState("SunFutures Plant");
  const [dcKw, setDcKw] = useState("250000");
  const [acKw, setAcKw] = useState("200000");
  const [gcr, setGcr] = useState(0.35);
  const [maxAngle, setMaxAngle] = useState(60);
  const [backtracking, setBacktracking] = useState(true);
  const [poiLimit, setPoiLimit] = useState("");
  const [mounting, setMounting] = useState<"SAT" | "FIXED">("SAT");
  const [tiltDeg, setTiltDeg] = useState("25");
  const [azimuthDeg, setAzimuthDeg] = useState("180");

  // Losses
  const [soiling, setSoiling] = useState(2.0);
  const [snow, setSnow] = useState(0.0);
  const [mismatch, setMismatch] = useState(1.5);
  const [dcWiring, setDcWiring] = useState(1.5);
  const [acWiring, setAcWiring] = useState(1.0);
  const [iam, setIam] = useState(1.0);
  const [aux, setAux] = useState(0.5);
  const [avail, setAvail] = useState(99.0);

  // Equipment
  const [uploaded, setUploaded] = useState<UploadedFile[]>([]);
  const [equipmentSets, setEquipmentSets] = useState<any[]>(DEFAULT_EQUIPMENT_SETS);
  const [selectedEquipSet, setSelectedEquipSet] = useState<string>(DEFAULT_EQUIPMENT_SETS[0].id);

  // Results
  const [result, setResult] = useState<ForecastResp | null>(null);
  const [reportResult, setReportResult] = useState<any | null>(null);
  const chartShotRef = useRef<any>(null);

  // Portfolio
  const [savedPlants, setSavedPlants] = useState<any[]>([]);
  const [portfolioResult, setPortfolioResult] = useState<ForecastResp | null>(null);

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  const STORAGE_KEY = "sunfutures_saved_plants_v1";
  const EQUIP_SETS_KEY = "sunfutures_equipment_sets_v1";

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        setSavedPlants(raw ? JSON.parse(raw) : []);
      } catch {
        setSavedPlants([]);
      }
      try {
        const raw = await AsyncStorage.getItem(EQUIP_SETS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setEquipmentSets(parsed.length ? parsed : DEFAULT_EQUIPMENT_SETS);
      } catch {
        // ignore
      }
    })();
  }, []);

  const persistSavedPlants = async (plants: any[]) => {
    setSavedPlants(plants);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(plants));
  };

  const persistEquipmentSets = async (sets: any[]) => {
    setEquipmentSets(sets);
    await AsyncStorage.setItem(EQUIP_SETS_KEY, JSON.stringify(sets));
  };

  const applyPreset = (presetId: string) => {
    const p = PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    setSelectedPreset(presetId);
    setMounting(p.mounting);
    setGcr(p.plant.gcr);
    setMaxAngle(p.plant.maxAngle);
    setBacktracking(!!p.plant.backtracking);

    if (p.mounting === "FIXED") {
      setTiltDeg(String((p.plant as any).tilt ?? 25));
      setAzimuthDeg(String((p.plant as any).azimuth ?? 180));
    }

    setSoiling(p.losses.soiling);
    setSnow(p.losses.snow);
    setMismatch(p.losses.mismatch);
    setDcWiring(p.losses.dcWiring);
    setAcWiring(p.losses.acWiring);
    setIam(p.losses.iam);
    setAux(p.losses.aux);
    setAvail(p.losses.avail);
  };

  const region = useMemo(
    () => ({
      latitude: lat,
      longitude: lon,
      latitudeDelta: 0.22,
      longitudeDelta: 0.22,
    }),
    [lat, lon]
  );

  const pickOnMap = (e: MapPressEvent) => {
    setLat(Number(e.nativeEvent.coordinate.latitude.toFixed(6)));
    setLon(Number(e.nativeEvent.coordinate.longitude.toFixed(6)));
  };

  const useDeviceLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") throw new Error("Location permission denied");
    const loc = await Location.getCurrentPositionAsync({});
    setLat(Number(loc.coords.latitude.toFixed(6)));
    setLon(Number(loc.coords.longitude.toFixed(6)));
    if (loc.coords.altitude != null) setElev(String(Math.round(loc.coords.altitude)));
  };


const stepIsComplete = (stepId: string) => {
  if (stepId === "site") {
    return Number.isFinite(lat) && Number.isFinite(lon);
  }
  if (stepId === "plant") {
    if (!dcKw || Number(dcKw) <= 0) return false;
    if (!acKw || Number(acKw) <= 0) return false;
    if (dcKw && acKw && Number(dcKw) < Number(acKw)) return false;
    if (mounting === "FIXED") {
      if (!tiltDeg || isNaN(Number(tiltDeg))) return false;
      if (!azimuthDeg || isNaN(Number(azimuthDeg))) return false;
    }
    return true;
  }
  return true;
};

const validateStep = (stepId: string) => {
  const e: Record<string, string> = {};
  if (stepId === "site") {
    if (!Number.isFinite(lat)) e.lat = "Latitude is required";
    if (!Number.isFinite(lon)) e.lon = "Longitude is required";
  }
  if (stepId === "plant") {
    if (!dcKw || Number(dcKw) <= 0) e.dcKw = "DC capacity must be > 0";
    if (!acKw || Number(acKw) <= 0) e.acKw = "AC capacity must be > 0";
    if (dcKw && acKw && Number(dcKw) < Number(acKw)) e.dcKw = "DC should usually be ≥ AC";
    if (mounting === "FIXED") {
      if (!tiltDeg || isNaN(Number(tiltDeg))) e.tilt = "Tilt is required";
      if (!azimuthDeg || isNaN(Number(azimuthDeg))) e.azimuth = "Azimuth is required";
    }
  }
  setErrors(e);
  return Object.keys(e).length === 0;
};

const validate = () => {
    // Full-form validation (used for Run).
    const e: Record<string, string> = {};
    if (!Number.isFinite(lat)) e.lat = "Latitude is required";
    if (!Number.isFinite(lon)) e.lon = "Longitude is required";
    if (!dcKw || Number(dcKw) <= 0) e.dcKw = "DC capacity must be > 0";
    if (!acKw || Number(acKw) <= 0) e.acKw = "AC capacity must be > 0";
    if (dcKw && acKw && Number(dcKw) < Number(acKw))
      e.dcKw = "DC should usually be ≥ AC";
    if (mounting === "FIXED") {
      if (!tiltDeg || isNaN(Number(tiltDeg))) e.tilt = "Tilt is required";
      if (!azimuthDeg || isNaN(Number(azimuthDeg))) e.azimuth = "Azimuth is required";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const buildPayload = () => ({
    location: {
      name: siteName || null,
      lat,
      lon,
      elevation_m: elev ? Number(elev) : null,
    },
    plant: {
      plant_name: plantName,
      dc_capacity_kw: Number(dcKw),
      ac_capacity_kw: Number(acKw),
      mounting: mounting,
      tilt_deg: mounting === "FIXED" ? Number(tiltDeg) : null,
      azimuth_deg: mounting === "FIXED" ? Number(azimuthDeg) : null,
      gcr: mounting === "SAT" ? Number(gcr) : Number(gcr),
      max_tracker_angle_deg: mounting === "SAT" ? Number(maxAngle) : null,
      backtracking: mounting === "SAT" ? backtracking : null,
      poi_limit_kw: poiLimit ? Number(poiLimit) : null,
    },
    losses: {
      soiling_pct: soiling,
      snow_pct: snow,
      mismatch_pct: mismatch,
      dc_wiring_pct: dcWiring,
      ac_wiring_pct: acWiring,
      iam_pct: iam,
      aux_pct: aux,
      availability_pct: avail,
    },
    equipment_files: uploaded.map((u) => ({
      file_id: u.file_id,
      filename: u.filename,
      kind: u.kind,
    })),
  });

  const doForecast = async () => {
    if (!validate()) {
      Alert.alert("Fix required fields", "Please correct the highlighted fields.");
      return;
    }
    setBusy(true);
    setResult(null);
    setReportResult(null);
    try {
      const r = await runForecast(buildPayload());
      setResult(r);
    } catch (e: any) {
      Alert.alert("Forecast error", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const doReport = async () => {
    setBusy(true);
    try {
      const rep = await runReport(buildPayload());
      setReportResult(rep);
      const avgPr = rep?.kpis?.summary?.avg_pr;
      const tot = rep?.kpis?.summary?.total_kwh;
      Alert.alert(
        "Report generated",
        `Total: ${formatNumber(tot ?? 0)} kWh\nAvg PR: ${(avgPr ?? 0).toFixed(3)}`
      );
    } catch (e: any) {
      Alert.alert("Report error", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickEquipmentFiles = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["*/*"],
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;

    setBusy(true);
    try {
      const files = res.assets ?? [];
      if (!files.length) return;

      const form: { uri: string; name: string; type: string }[] = [];
      for (const f of files) {
        form.push({
          uri: f.uri,
          name: f.name ?? "file",
          type: f.mimeType ?? "application/octet-stream",
        });
      }

      const uploadedResp = await uploadEquipment(form);
      // uploadedResp.uploaded matches UploadedFile in api.ts; store it
      setUploaded((prev) => [...uploadedResp.uploaded, ...prev]);
      Alert.alert("Uploaded", `Uploaded ${uploadedResp.uploaded.length} file(s).`);
    } catch (e: any) {
      Alert.alert("Upload error", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const WizardScreen = () => {
    const step = STEPS[stepIdx];

    return (
      <View>
        <StepHeader
          step={stepIdx + 1}
          total={STEPS.length}
          title={step.title}
          subtitle={step.subtitle}
        />

        <Text style={styles.label}>Presets</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {PRESETS.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => applyPreset(p.id)}
                style={[
                  styles.pill,
                  { minWidth: 190 },
                  selectedPreset === p.id ? styles.pillActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.pillText,
                    selectedPreset === p.id ? styles.pillTextActive : null,
                  ]}
                  numberOfLines={1}
                >
                  {p.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        {step.id === "site" ? (
          <Card title="Site">
            <View
              style={{
                height: 280,
                borderRadius: 16,
                overflow: "hidden",
                borderWidth: 1,
                borderColor: "#e5e7eb",
              }}
            >
              <MapView
                style={{ flex: 1 }}
                region={region}
                provider={Platform.OS === "ios" ? "apple" : undefined}
                onPress={pickOnMap}
              >
                <Marker
                  coordinate={{ latitude: lat, longitude: lon }}
                  draggable
                  onDragEnd={(e) => {
                    setLat(Number(e.nativeEvent.coordinate.latitude.toFixed(6)));
                    setLon(Number(e.nativeEvent.coordinate.longitude.toFixed(6)));
                  }}
                />
              </MapView>
            </View>

            <View style={{ marginTop: 12 }}>
              <Button
                title={locBusy ? "Locating…" : "Use device location"}
                tone="secondary"
                disabled={locBusy || busy}
                onPress={async () => {
                  try {
                    setLocBusy(true);
                    await useDeviceLocation();
                  } catch (e: any) {
                    Alert.alert("Location error", e?.message ?? String(e));
                  } finally {
                    setLocBusy(false);
                  }
                }}
              />
            </View>

            <View style={styles.divider} />

            <Field label="Site name (optional)" value={siteName} onChangeText={setSiteName} placeholder="Las Vegas PV" />
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Latitude"
                  value={String(lat)}
                  onChangeText={(v) => setLat(Number(v))}
                  keyboardType="decimal-pad"
                  error={errors.lat}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Longitude"
                  value={String(lon)}
                  onChangeText={(v) => setLon(Number(v))}
                  keyboardType="decimal-pad"
                  error={errors.lon}
                />
              </View>
            </View>
            <Field
              label="Elevation (m, optional)"
              value={elev}
              onChangeText={setElev}
              keyboardType="decimal-pad"
              placeholder="610"
            />
          </Card>
        ) : null}

        {step.id === "plant" ? (
          <Card title="Plant">
            <Field label="Plant name" value={plantName} onChangeText={setPlantName} />
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Field
                  label="DC capacity (kW)"
                  value={dcKw}
                  onChangeText={setDcKw}
                  keyboardType="decimal-pad"
                  error={errors.dcKw}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="AC capacity (kW)"
                  value={acKw}
                  onChangeText={setAcKw}
                  keyboardType="decimal-pad"
                  error={errors.acKw}
                />
              </View>
            
<Text style={{ color: "#6b7280", marginBottom: 10 }}>
  DC/AC ratio:{" "}
  <Text style={{ fontWeight: "900", color: "#111827" }}>
    {Number(acKw) > 0 ? (Number(dcKw) / Number(acKw)).toFixed(2) : "—"}
  </Text>
  {Number(acKw) > 0 && Number(dcKw) / Number(acKw) < 1.0 ? (
    <Text style={{ color: "#dc2626" }}>  (unusual: DC &lt; AC)</Text>
  ) : null}
  {Number(acKw) > 0 && Number(dcKw) / Number(acKw) > 1.6 ? (
    <Text style={{ color: "#b45309" }}>  (high: expect clipping)</Text>
  ) : null}
</Text>
</View>

            <Text style={styles.label}>Mounting</Text>
            <View style={[styles.row, { marginBottom: 12 }]}>
              <Pressable
                onPress={() => setMounting("SAT")}
                style={[
                  styles.pill,
                  { flex: 1 },
                  mounting === "SAT" ? styles.pillActive : null,
                ]}
              >
                <Text style={[styles.pillText, mounting === "SAT" ? styles.pillTextActive : null]}>
                  Single-axis tracking
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setMounting("FIXED")}
                style={[
                  styles.pill,
                  { flex: 1 },
                  mounting === "FIXED" ? styles.pillActive : null,
                ]}
              >
                <Text style={[styles.pillText, mounting === "FIXED" ? styles.pillTextActive : null]}>
                  Fixed tilt
                </Text>
              </Pressable>
            </View>

            {mounting === "SAT" ? (
              <>
                <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Button title="Run again" tone="secondary" disabled={busy} onPress={doForecast} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Edit inputs"
                      tone="secondary"
                      disabled={busy}
                      onPress={() => {
                        setStepIdx(0);
                        setResult(null);
                        setReportResult(null);
                      }}
                    />
                  </View>
                </View>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="GCR"
                      value={String(gcr)}
                      onChangeText={(v) => setGcr(Number(v))}
                      keyboardType="decimal-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Max tracker angle (°)"
                      value={String(maxAngle)}
                      onChangeText={(v) => setMaxAngle(Number(v))}
                      keyboardType="decimal-pad"
                    />
                  </View>
                </View>

                <Pressable
                  onPress={() => setBacktracking(!backtracking)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}
                >
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      borderWidth: 2,
                      borderColor: "#111827",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {backtracking ? <Text style={{ fontWeight: "900" }}>✓</Text> : null}
                  </View>
                  <Text style={{ fontWeight: "800" }}>Backtracking</Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Tilt (°)"
                      value={tiltDeg}
                      onChangeText={setTiltDeg}
                      keyboardType="decimal-pad"
                      error={errors.tilt}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Azimuth (°)"
                      value={azimuthDeg}
                      onChangeText={setAzimuthDeg}
                      keyboardType="decimal-pad"
                      error={errors.azimuth}
                    />
                  </View>
                </View>
                <Field
                  label="GCR"
                  value={String(gcr)}
                  onChangeText={(v) => setGcr(Number(v))}
                  keyboardType="decimal-pad"
                />
              </>
            )}

            <Field
              label="POI limit (kW, optional)"
              value={poiLimit}
              onChangeText={setPoiLimit}
              keyboardType="decimal-pad"
              placeholder="Leave blank for none"
            />

            <Button
              title="Save plant to portfolio"
              tone="secondary"
              disabled={busy}
              onPress={async () => {
                if (!validate()) {
                  Alert.alert("Fix required fields", "Please correct the highlighted fields first.");
                  return;
                }
                const plantConfig = {
                  id: `${Date.now()}`,
                  name: plantName,
                  location: { name: siteName || null, lat, lon, elevation_m: elev ? Number(elev) : null },
                  plant: {
                    plant_name: plantName,
                    dc_capacity_kw: Number(dcKw),
                    ac_capacity_kw: Number(acKw),
                    mounting,
                    tilt_deg: mounting === "FIXED" ? Number(tiltDeg) : null,
                    azimuth_deg: mounting === "FIXED" ? Number(azimuthDeg) : null,
                    gcr: Number(gcr),
                    max_tracker_angle_deg: mounting === "SAT" ? Number(maxAngle) : null,
                    backtracking: mounting === "SAT" ? backtracking : null,
                    poi_limit_kw: poiLimit ? Number(poiLimit) : null,
                  },
                  losses: {
                    soiling_pct: soiling,
                    snow_pct: snow,
                    mismatch_pct: mismatch,
                    dc_wiring_pct: dcWiring,
                    ac_wiring_pct: acWiring,
                    iam_pct: iam,
                    aux_pct: aux,
                    availability_pct: avail,
                  },
                };
                const next = [plantConfig, ...savedPlants].slice(0, 50);
                await persistSavedPlants(next);
                Alert.alert("Saved", `Saved ${plantName} to portfolio`);
              }}
            />
          </Card>
        ) : null}

        {step.id === "losses" ? (
          <Card title="Losses">
            <Text style={styles.help}>These are percent losses (0–10 typical for most). Defaults come from selected preset.</Text>

            <Text style={styles.label}>Soiling: {soiling.toFixed(1)}%</Text>
            <Slider minimumValue={0} maximumValue={10} value={soiling} onValueChange={setSoiling} />

            <Text style={styles.label}>IAM: {iam.toFixed(1)}%</Text>
            <Slider minimumValue={0} maximumValue={10} value={iam} onValueChange={setIam} />

            <Text style={styles.label}>Snow: {snow.toFixed(1)}%</Text>
            <Slider minimumValue={0} maximumValue={15} value={snow} onValueChange={setSnow} />

            <Text style={styles.label}>Mismatch: {mismatch.toFixed(1)}%</Text>
            <Slider minimumValue={0} maximumValue={6} value={mismatch} onValueChange={setMismatch} />

            <Text style={styles.label}>DC wiring: {dcWiring.toFixed(1)}%</Text>
            <Slider minimumValue={0} maximumValue={5} value={dcWiring} onValueChange={setDcWiring} />

            <Text style={styles.label}>AC wiring: {acWiring.toFixed(1)}%</Text>
            <Slider minimumValue={0} maximumValue={5} value={acWiring} onValueChange={setAcWiring} />

            <Text style={styles.label}>Aux consumption: {aux.toFixed(1)}%</Text>
            <Slider minimumValue={0} maximumValue={5} value={aux} onValueChange={setAux} />

            <Text style={styles.label}>Availability: {avail.toFixed(1)}%</Text>
            <Slider minimumValue={90} maximumValue={100} value={avail} onValueChange={setAvail} />
          </Card>
        ) : null}

        {step.id === "equipment" ? (
          <Card title="Equipment">
            <Text style={styles.help}>Upload PVsyst files (.PAN/.OND) for more accurate modeling and clipping.</Text>

            <Text style={styles.label}>Equipment sets</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: "row", gap: 10 }}>
                {equipmentSets.map((s: any) => (
                  <Pressable
                    key={s.id}
                    onPress={() => {
                      setSelectedEquipSet(s.id);
                      if (Array.isArray(s.files)) setUploaded(s.files);
                    }}
                    style={[
                      styles.pill,
                      { minWidth: 200 },
                      selectedEquipSet === s.id ? styles.pillActive : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        selectedEquipSet === s.id ? styles.pillTextActive : null,
                      ]}
                      numberOfLines={1}
                    >
                      {s.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>

            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Button
                  title={busy ? "Working…" : "Upload files"}
                  onPress={pickEquipmentFiles}
                  disabled={busy}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title="Save set"
                  tone="secondary"
                  disabled={busy}
                  onPress={async () => {
                    const name = `Set ${equipmentSets.length + 1}`;
                    const next = [{ id: `${Date.now()}`, name, files: uploaded }, ...equipmentSets].slice(0, 30);
                    await persistEquipmentSets(next);
                    setSelectedEquipSet(next[0].id);
                    Alert.alert("Saved", "Equipment set saved.");
                  }}
                />
              </View>
            </View>

            <View style={styles.divider} />

            <Text style={{ fontWeight: "800" }}>Uploaded</Text>
            {uploaded.length ? (
              uploaded.slice(0, 10).map((u, idx) => (
                <Pressable
                  key={`${u.file_id}-${idx}`}
                  onPress={() => {
                    Alert.alert(
                      "Remove file?",
                      `${u.filename}`,
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Remove",
                          style: "destructive",
                          onPress: () => setUploaded((prev) => prev.filter((_, j) => j !== idx)),
                        },
                      ]
                    );
                  }}
                >
                  <Text style={{ color: "#6b7280" }}>• {u.kind}: {u.filename}  (tap to remove)</Text>
                </Pressable>
              ))
            ) : (
              <Text style={{ color: "#6b7280" }}>None</Text>
            )}
            {uploaded.length > 10 ? <Text style={{ color: "#6b7280" }}>…</Text> : null}
          </Card>
        ) : null}

        {step.id === "review" ? (
          <Card title="Review">
            <Text style={styles.help}>Review your configuration. Tap Back to make changes.</Text>
            <View style={{ marginTop: 10 }}>
              <Text style={{ fontWeight: "900" }}>Site</Text>
              <Text style={{ color: "#6b7280" }}>
                {siteName || "—"} • {lat.toFixed(4)}, {lon.toFixed(4)} {elev ? `• ${elev}m` : ""}
              </Text>
            </View>

            <View style={{ marginTop: 10 }}>
              <Text style={{ fontWeight: "900" }}>Plant</Text>
              <Text style={{ color: "#6b7280" }}>
                {plantName} • DC {formatNumber(Number(dcKw))} kW • AC {formatNumber(Number(acKw))} kW
              </Text>
              <Text style={{ color: "#6b7280" }}>
                {mounting === "SAT"
                  ? `SAT • GCR ${Number(gcr).toFixed(2)} • Angle ${Number(maxAngle).toFixed(0)}° • Backtracking ${backtracking ? "On" : "Off"}`
                  : `Fixed • Tilt ${tiltDeg}° • Azimuth ${azimuthDeg}° • GCR ${Number(gcr).toFixed(2)}`}
              </Text>
            </View>

            <View style={{ marginTop: 10 }}>
              <Text style={{ fontWeight: "900" }}>Losses</Text>
              <Text style={{ color: "#6b7280" }}>
                Soiling {soiling}% • IAM {iam}% • Snow {snow}% • Availability {avail}%
              </Text>
            </View>

            <View style={{ marginTop: 10 }}>
              <Text style={{ fontWeight: "900" }}>Equipment</Text>
              <Text style={{ color: "#6b7280" }}>Uploaded files: {uploaded.length}</Text>
            </View>

            <View style={styles.divider} />
            <Text style={{ color: "#6b7280" }}>
              Next: tap <Text style={{ fontWeight: "900" }}>Run forecast</Text>.
            </Text>
          </Card>
        ) : null}

        {step.id === "run" ? (
          <Card title="Results">
            {!result ? (
              <Text style={{ color: "#6b7280" }}>
                No results yet. Tap <Text style={{ fontWeight: "900" }}>Run forecast</Text>.
              </Text>
            ) : (
              <>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Export CSV"
                      tone="secondary"
                      disabled={busy}
                      onPress={async () => {
                        try {
                          await shareCsv(
                            `sunfutures_${result.daily_kwh[0]?.date ?? "export"}.csv`,
                            toCsv(result.daily_kwh)
                          );
                        } catch (e: any) {
                          Alert.alert("Export error", e?.message ?? String(e));
                        }
                      }}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Share chart"
                      tone="secondary"
                      disabled={busy}
                      onPress={async () => {
                        try {
                          await sharePngFromRef(chartShotRef.current);
                        } catch (e: any) {
                          Alert.alert("Share error", e?.message ?? String(e));
                        }
                      }}
                    />
                  </View>
                </View>

                <View style={{ marginTop: 10 }}>
                  <Button
                    title="Generate report"
                    disabled={busy}
                    onPress={doReport}
                  />
                </View>

                <View style={{ marginTop: 10 }}>
                  <Button
                    title="Share report JSON"
                    tone="secondary"
                    disabled={busy || !reportResult}
                    onPress={async () => {
                      try {
                        if (!reportResult) return;
                        await shareJson(
                          `sunfutures_report_${result.daily_kwh[0]?.date ?? "export"}.json`,
                          reportResult
                        );
                      } catch (e: any) {
                        Alert.alert("Share error", e?.message ?? String(e));
                      }
                    }}
                  />
                </View>

                <View style={styles.divider} />

                <ViewShot ref={chartShotRef} options={{ format: "png", quality: 1.0 }}>
                  <ForecastChart rows={result.daily_kwh} bands={result.sources_used?.probabilistic} />
                </ViewShot>

                <View style={styles.divider} />

                {result.daily_kwh.map((d) => (
                  <View
                    key={d.date}
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      paddingVertical: 6,
                      borderBottomWidth: 1,
                      borderBottomColor: "#f3f4f6",
                    }}
                  >
                    <Text>{d.date}</Text>
                    <Text style={{ fontWeight: "900" }}>{formatNumber(d.kwh)} kWh</Text>
                  </View>
                ))}
              </>
            )}
          </Card>
        ) : null}
      </View>
    );
  };

  const AdvancedForecastScreen = () => (
    <View>
      {/* Quick presets */}
      <Card title="Presets">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {PRESETS.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => applyPreset(p.id)}
                style={[
                  styles.pill,
                  { minWidth: 190 },
                  selectedPreset === p.id ? styles.pillActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.pillText,
                    selectedPreset === p.id ? styles.pillTextActive : null,
                  ]}
                  numberOfLines={1}
                >
                  {p.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </Card>

      {/* Site */}
      <Card title="Site">
        <View
          style={{
            height: 220,
            borderRadius: 16,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: "#e5e7eb",
          }}
        >
          <MapView
            style={{ flex: 1 }}
            region={region}
            provider={Platform.OS === "ios" ? "apple" : undefined}
            onPress={pickOnMap}
          >
            <Marker coordinate={{ latitude: lat, longitude: lon }} />
          </MapView>
        </View>

        <View style={{ marginTop: 10 }}>
          <Button
            title={locBusy ? "Locating…" : "Use device location"}
            tone="secondary"
            disabled={locBusy || busy}
            onPress={async () => {
              try {
                setLocBusy(true);
                await useDeviceLocation();
              } catch (e: any) {
                Alert.alert("Location error", e?.message ?? String(e));
              } finally {
                setLocBusy(false);
              }
            }}
          />
        </View>

        <View style={styles.divider} />
        <Field label="Site name (optional)" value={siteName} onChangeText={setSiteName} placeholder="Las Vegas PV" />
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="Latitude" value={String(lat)} onChangeText={(v) => setLat(Number(v))} keyboardType="decimal-pad" error={errors.lat} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Longitude" value={String(lon)} onChangeText={(v) => setLon(Number(v))} keyboardType="decimal-pad" error={errors.lon} />
          </View>
        </View>
        <Field label="Elevation (m, optional)" value={elev} onChangeText={setElev} keyboardType="decimal-pad" placeholder="610" />
      </Card>

      {/* Plant */}
      <Card title="Plant">
        <Field label="Plant name" value={plantName} onChangeText={setPlantName} />
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Field label="DC capacity (kW)" value={dcKw} onChangeText={setDcKw} keyboardType="decimal-pad" error={errors.dcKw} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="AC capacity (kW)" value={acKw} onChangeText={setAcKw} keyboardType="decimal-pad" error={errors.acKw} />
          </View>
        </View>

        <Text style={styles.label}>Mounting</Text>
        <View style={[styles.row, { marginBottom: 12 }]}>
          <Pressable onPress={() => setMounting("SAT")} style={[styles.pill, { flex: 1 }, mounting === "SAT" ? styles.pillActive : null]}>
            <Text style={[styles.pillText, mounting === "SAT" ? styles.pillTextActive : null]}>Single-axis tracking</Text>
          </Pressable>
          <Pressable onPress={() => setMounting("FIXED")} style={[styles.pill, { flex: 1 }, mounting === "FIXED" ? styles.pillActive : null]}>
            <Text style={[styles.pillText, mounting === "FIXED" ? styles.pillTextActive : null]}>Fixed tilt</Text>
          </Pressable>
        </View>

        {mounting === "SAT" ? (
          <>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Field label="GCR" value={String(gcr)} onChangeText={(v) => setGcr(Number(v))} keyboardType="decimal-pad" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Max tracker angle (°)" value={String(maxAngle)} onChangeText={(v) => setMaxAngle(Number(v))} keyboardType="decimal-pad" />
              </View>
            </View>
            <Pressable onPress={() => setBacktracking(!backtracking)} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: "#111827", alignItems: "center", justifyContent: "center" }}>
                {backtracking ? <Text style={{ fontWeight: "900" }}>✓</Text> : null}
              </View>
              <Text style={{ fontWeight: "800" }}>Backtracking</Text>
            </Pressable>
          </>
        ) : (
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Field label="Tilt (°)" value={tiltDeg} onChangeText={setTiltDeg} keyboardType="decimal-pad" error={errors.tilt} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Azimuth (°)" value={azimuthDeg} onChangeText={setAzimuthDeg} keyboardType="decimal-pad" error={errors.azimuth} />
            </View>
          </View>
        )}

        <Field label="POI limit (kW, optional)" value={poiLimit} onChangeText={setPoiLimit} keyboardType="decimal-pad" placeholder="Leave blank" />
      </Card>

      {/* Losses */}
      <Card title="Losses">
        <Text style={styles.label}>Soiling: {soiling.toFixed(1)}%</Text>
        <Slider minimumValue={0} maximumValue={10} value={soiling} onValueChange={setSoiling} />
        <Text style={styles.label}>IAM: {iam.toFixed(1)}%</Text>
        <Slider minimumValue={0} maximumValue={10} value={iam} onValueChange={setIam} />
        <Text style={styles.label}>Snow: {snow.toFixed(1)}%</Text>
        <Slider minimumValue={0} maximumValue={15} value={snow} onValueChange={setSnow} />
        <Text style={styles.label}>Mismatch: {mismatch.toFixed(1)}%</Text>
        <Slider minimumValue={0} maximumValue={6} value={mismatch} onValueChange={setMismatch} />
        <Text style={styles.label}>DC wiring: {dcWiring.toFixed(1)}%</Text>
        <Slider minimumValue={0} maximumValue={5} value={dcWiring} onValueChange={setDcWiring} />
        <Text style={styles.label}>AC wiring: {acWiring.toFixed(1)}%</Text>
        <Slider minimumValue={0} maximumValue={5} value={acWiring} onValueChange={setAcWiring} />
        <Text style={styles.label}>Aux consumption: {aux.toFixed(1)}%</Text>
        <Slider minimumValue={0} maximumValue={5} value={aux} onValueChange={setAux} />
        <Text style={styles.label}>Availability: {avail.toFixed(1)}%</Text>
        <Slider minimumValue={90} maximumValue={100} value={avail} onValueChange={setAvail} />
      </Card>

      {/* Equipment */}
      <Card title="Equipment">
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Button title="Upload files" disabled={busy} onPress={pickEquipmentFiles} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Save set"
              tone="secondary"
              disabled={busy}
              onPress={async () => {
                const name = `Set ${equipmentSets.length + 1}`;
                const next = [{ id: `${Date.now()}`, name, files: uploaded }, ...equipmentSets].slice(0, 30);
                await persistEquipmentSets(next);
                setSelectedEquipSet(next[0].id);
                Alert.alert("Saved", "Equipment set saved.");
              }}
            />
          </View>
        </View>

        <View style={styles.divider} />

        <Text style={{ fontWeight: "800" }}>Uploaded</Text>
        {uploaded.length ? (
          uploaded.slice(0, 10).map((u, idx) => (
            <Text key={`${u.file_id}-${idx}`} style={{ color: "#6b7280" }}>
              • {u.kind}: {u.filename}
            </Text>
          ))
        ) : (
          <Text style={{ color: "#6b7280" }}>None</Text>
        )}
      </Card>

      {/* Results */}
      {result ? (
        <Card title="Results">
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Button
                title="Export CSV"
                tone="secondary"
                disabled={busy}
                onPress={async () => shareCsv(`sunfutures_${result.daily_kwh[0]?.date ?? "export"}.csv`, toCsv(result.daily_kwh))}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Share chart" tone="secondary" disabled={busy} onPress={async () => sharePngFromRef(chartShotRef.current)} />
            </View>
          </View>

          <View style={{ marginTop: 10 }}>
            <Button title="Generate report" disabled={busy} onPress={doReport} />
          </View>

          <View style={{ marginTop: 10 }}>
            <Button title="Share report JSON" tone="secondary" disabled={busy || !reportResult} onPress={async () => reportResult && shareJson(`sunfutures_report_${result.daily_kwh[0]?.date ?? "export"}.json`, reportResult)} />
          </View>

          <View style={styles.divider} />

          <ViewShot ref={chartShotRef} options={{ format: "png", quality: 1.0 }}>
            <ForecastChart rows={result.daily_kwh} bands={result.sources_used?.probabilistic} />
          </ViewShot>
        </Card>
      ) : null}
    </View>
  );

  const PortfolioScreen = () => (
    <Card title="Portfolio">
      <Text style={{ color: "#6b7280", marginBottom: 10 }}>
        Saved plants: {savedPlants.length}
      </Text>

      <Button
        title={busy ? "Working…" : "Run portfolio forecast"}
        disabled={busy}
        onPress={async () => {
          if (!savedPlants.length) {
            Alert.alert("No plants", "Save at least one plant first.");
            return;
          }
          setBusy(true);
          setPortfolioResult(null);
          try {
            const results = await Promise.all(
              savedPlants.map(async (p) => {
                const payload = {
                  location: p.location,
                  plant: p.plant,
                  losses: p.losses,
                  equipment_files: [],
                };
                return await runForecast(payload);
              })
            );

            const map: Record<string, number> = {};
            for (const r of results) {
              for (const d of r.daily_kwh) {
                map[d.date] = (map[d.date] ?? 0) + d.kwh;
              }
            }
            const daily_kwh = Object.keys(map)
              .sort()
              .map((date) => ({ date, kwh: Number(map[date].toFixed(2)) }));

            setPortfolioResult({
              daily_kwh,
              sources_used: { portfolio: { n_plants: savedPlants.length } } as any,
              notes: ["Portfolio P50 is the sum of plant P50 series."],
            } as any);
          } catch (e: any) {
            Alert.alert("Portfolio error", e?.message ?? String(e));
          } finally {
            setBusy(false);
          }
        }}
      />

      <View style={styles.divider} />

      {savedPlants.slice(0, 25).map((p) => (
        <View
          key={p.id}
          style={{
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: "#f3f4f6",
          }}
        >
          <Text style={{ fontWeight: "900" }}>{p.name}</Text>
          <Text style={{ color: "#6b7280", fontSize: 12 }}>
            {p.location?.lat?.toFixed?.(3)},{p.location?.lon?.toFixed?.(3)} • DC{" "}
            {Math.round(p.plant?.dc_capacity_kw).toLocaleString()} kW
          </Text>
          <Pressable
            onPress={async () => {
              const next = savedPlants.filter((x: any) => x.id !== p.id);
              await persistSavedPlants(next);
            }}
            style={{ marginTop: 6 }}
          >
            <Text style={{ color: "#dc2626", fontWeight: "900" }}>Remove</Text>
          </Pressable>
        </View>
      ))}

      {portfolioResult ? (
        <>
          <View style={styles.divider} />
          <Button
            title="Export portfolio CSV"
            tone="secondary"
            disabled={busy}
            onPress={async () => shareCsv(`sunfutures_portfolio_${portfolioResult.daily_kwh[0]?.date ?? "export"}.csv`, toCsv(portfolioResult.daily_kwh))}
          />
          <View style={styles.divider} />
          <ForecastChart rows={portfolioResult.daily_kwh} />
        </>
      ) : null}
    </Card>
  );

  
// Wizard footer nav (with step gating)
const WizardFooter = () => {
  const atFirst = stepIdx === 0;
  const step = STEPS[stepIdx];

  const nextLabel = step.id === "review" ? "Run forecast" : "Next";

  const onNext = async () => {
    if (busy) return;

    if (step.id === "run") return;

    if (step.id === "review") {
      // Full validation before running
      if (!validate()) {
        Alert.alert("Fix required fields", "Please correct the highlighted fields.");
        // Jump user back to first failing step.
        if (!stepIsComplete("site")) setStepIdx(0);
        else if (!stepIsComplete("plant")) setStepIdx(1);
        return;
      }
      setErrors({});
      setStepIdx(stepIdx + 1); // move to run
      await doForecast();
      return;
    }

    // Gate step progression (site/plant)
    if (step.id === "site") {
      if (!validateStep("site")) {
        Alert.alert("Fix required fields", "Please correct the highlighted fields.");
        return;
      }
    }
    if (step.id === "plant") {
      if (!validateStep("plant")) {
        Alert.alert("Fix required fields", "Please correct the highlighted fields.");
        return;
      }
    }

    setErrors({});
    setStepIdx((i) => Math.min(STEPS.length - 1, i + 1));
  };

  const onBack = () => {
    if (busy) return;
    setErrors({});
    setStepIdx((i) => Math.max(0, i - 1));
  };

  const disableNext =
    busy ||
    (step.id === "site" && !stepIsComplete("site")) ||
    (step.id === "plant" && !stepIsComplete("plant")) ||
    step.id === "run";

  return (
    <View style={styles.fabBar}>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Pressable
            onPress={onBack}
            disabled={atFirst || busy}
            style={[
              styles.fabButton,
              { backgroundColor: "white", borderWidth: 1, borderColor: "#e5e7eb" },
              atFirst || busy ? styles.fabButtonDisabled : null,
            ]}
          >
            <Text style={[styles.fabText, { color: "#111827" }]}>Back</Text>
          </Pressable>
        </View>

        <View style={{ flex: 1.6 }}>
          <Pressable
            onPress={onNext}
            disabled={disableNext}
            style={[styles.fabButton, disableNext ? styles.fabButtonDisabled : null]}
          >
            <Text style={styles.fabText}>{busy ? "Working…" : nextLabel}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
};

const AdvancedFooter = () => (
    <View style={styles.fabBar}>
      <Pressable
        onPress={doForecast}
        disabled={busy}
        style={[styles.fabButton, busy ? styles.fabButtonDisabled : null]}
      >
        <Text style={styles.fabText}>{busy ? "Running…" : "Run forecast"}</Text>
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 120 }}>
            <Text style={styles.h1}>SunFutures</Text>
            <Text style={styles.sub}>
              Apple Maps • Fly.io backend • 30-day kWh/day • CSV + chart + report
            </Text>

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 14 }}>
              <Pressable
                onPress={() => setMode("wizard")}
                style={[
                  styles.pill,
                  { flex: 1 },
                  mode === "wizard" ? styles.pillActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.pillText,
                    mode === "wizard" ? styles.pillTextActive : null,
                  ]}
                >
                  Wizard
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setMode("advanced")}
                style={[
                  styles.pill,
                  { flex: 1 },
                  mode === "advanced" ? styles.pillActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.pillText,
                    mode === "advanced" ? styles.pillTextActive : null,
                  ]}
                >
                  Advanced
                </Text>
              </Pressable>
            </View>

            {mode === "advanced" ? (
              <View style={{ flexDirection: "row", gap: 10, marginBottom: 14 }}>
                <Pressable
                  onPress={() => setTab("forecast")}
                  style={[
                    styles.pill,
                    { flex: 1 },
                    tab === "forecast" ? styles.pillActive : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.pillText,
                      tab === "forecast" ? styles.pillTextActive : null,
                    ]}
                  >
                    Forecast
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setTab("portfolio")}
                  style={[
                    styles.pill,
                    { flex: 1 },
                    tab === "portfolio" ? styles.pillActive : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.pillText,
                      tab === "portfolio" ? styles.pillTextActive : null,
                    ]}
                  >
                    Portfolio
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {mode === "wizard" ? <WizardScreen /> : tab === "portfolio" ? <PortfolioScreen /> : <AdvancedForecastScreen />}
          </ScrollView>

          {mode === "wizard" ? <WizardFooter /> : <AdvancedFooter />}
        </KeyboardAvoidingView>
      </TouchableWithoutFeedback>
    </SafeAreaView>
  );
}
