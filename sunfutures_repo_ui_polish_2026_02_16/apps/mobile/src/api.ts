import { API_BASE, API_KEY } from "./config";

export type UploadedFile = {
  file_id: string;
  filename: string;
  kind: "PAN" | "OND" | "OTHER";
  size_bytes: number;
};

function headers(extra?: Record<string, string>) {
  const h: Record<string, string> = { ...(extra ?? {}) };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

export async function uploadEquipment(uri: string, name: string, mimeType?: string): Promise<UploadedFile[]> {
  const form = new FormData();
  form.append("files", {
    // @ts-ignore React Native FormData file shape
    uri,
    name,
    type: mimeType ?? "application/octet-stream"
  });

  const res = await fetch(`${API_BASE}/v1/uploads`, {
    method: "POST",
    headers: headers(), // do NOT set Content-Type; RN will set boundary
    body: form as any
  });

  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.uploaded as UploadedFile[];
}

export type ForecastResp = {
  daily_kwh: { date: string; kwh: number }[];
  sources_used: any;
  notes: string[];
};

export async function runForecast(payload: any): Promise<ForecastResp> {
  const res = await fetch(`${API_BASE}/v1/forecast`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}


export async function runReport(payload: any): Promise<any> {
  return apiPost("/v1/report", payload);
}
