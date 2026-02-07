const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export async function fetchReports() {
  const res = await fetch(`${API_URL}/reports`, { cache: "no-store" });
  if (!res.ok) return [];
  return res.json();
}

export async function fetchIntegrations() {
  const res = await fetch(`${API_URL}/integrations`, { cache: "no-store" });
  if (!res.ok) return [];
  return res.json();
}

export async function fetchHealth() {
  const res = await fetch(`${API_URL}/health`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchConfig() {
  const res = await fetch(`${API_URL}/integrations/config`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchRunFiles(id: string) {
  const res = await fetch(`${API_URL}/reports/${id}/download`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchRunInputs(id: string) {
  const res = await fetch(`${API_URL}/reports/${id}/inputs`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchPermissions() {
  const res = await fetch(`${API_URL}/integrations/permissions`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export async function fixPermissions() {
  const res = await fetch(`${API_URL}/integrations/permissions/fix`, {
    method: "POST",
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}
