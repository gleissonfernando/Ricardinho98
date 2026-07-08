import { useEffect, useState } from "react";
import { Bell, ImageIcon, Loader2, Save, ShieldCheck } from "lucide-react";
import { getGuildLiveOptions, getOpenPointSettings, saveOpenPointSettings } from "../../lib/api";
import type { DashboardGuild, GuildChannelOption, GuildRoleOption, OpenPointSettings } from "../../types";
import { FivemResourceMultiSelect, FivemResourceSelect } from "../fivem/FivemResourceSelect";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Switch } from "../ui/switch";

type Props = {
  botId?: string | null;
  canManage: boolean;
  guild: DashboardGuild | null;
};

const DEFAULT_SETTINGS: OpenPointSettings = {
  id: "",
  botId: "",
  guildId: "",
  enabled: true,
  allowedRoleIds: [],
  fineChannelId: null,
  fineRoleId: null,
  justificationChannelId: null,
  logChannelId: null,
  dmBannerUrl: null,
  fineBannerUrl: null,
  fineMode: "once_at_3",
  createdAt: "",
  updatedAt: ""
};

export function OpenPointNotificationPanel({ botId, canManage, guild }: Props) {
  const [settings, setSettings] = useState<OpenPointSettings>(DEFAULT_SETTINGS);
  const [channels, setChannels] = useState<GuildChannelOption[]>([]);
  const [roles, setRoles] = useState<GuildRoleOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!guild || !botId) {
      setSettings(DEFAULT_SETTINGS);
      setChannels([]);
      setRoles([]);
      return;
    }

    let active = true;
    setLoading(true);
    setStatus(null);
    setError(null);

    Promise.all([
      getOpenPointSettings(guild.id, botId),
      getGuildLiveOptions(guild.id, botId)
    ])
      .then(([savedSettings, options]) => {
        if (!active) return;
        setSettings(savedSettings);
        setChannels(options.channels);
        setRoles(options.roles);
      })
      .catch((requestError) => {
        if (!active) return;
        setError(readErrorMessage(requestError, "Nao foi possivel carregar a notificacao de ponto aberto."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [botId, guild?.id]);

  function patch<K extends keyof OpenPointSettings>(key: K, value: OpenPointSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (!guild || !botId || !canManage) return;

    setSaving(true);
    setStatus(null);
    setError(null);

    try {
      const saved = await saveOpenPointSettings(guild.id, botId, {
        enabled: settings.enabled,
        allowedRoleIds: settings.allowedRoleIds,
        fineChannelId: settings.fineChannelId,
        fineRoleId: settings.fineRoleId,
        justificationChannelId: settings.justificationChannelId,
        logChannelId: settings.logChannelId,
        dmBannerUrl: normalizeUrl(settings.dmBannerUrl),
        fineBannerUrl: normalizeUrl(settings.fineBannerUrl),
        fineMode: settings.fineMode
      });
      setSettings(saved);
      setStatus("Sistema de ponto aberto salvo.");
    } catch (requestError) {
      setError(readErrorMessage(requestError, "Nao foi possivel salvar a configuracao."));
    } finally {
      setSaving(false);
    }
  }

  if (!guild) {
    return (
      <Card>
        <CardContent className="flex min-h-40 items-center justify-center p-6 text-sm text-zinc-500">
          Escolha um servidor para configurar o sistema de ponto aberto.
        </CardContent>
      </Card>
    );
  }

  const disabled = !canManage || loading || saving || !botId;
  const roleOptions = roles.map((role) => ({ color: role.color, disabled: role.managed, id: role.id, name: role.name }));
  const channelOptions = channels.map((channel) => ({ id: channel.id, name: channel.name }));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-black">
                <Bell className="h-5 w-5 text-zinc-200" />
              </div>
              <div>
                <CardTitle>Notificacao de ponto aberto</CardTitle>
                <CardDescription>Envia DM, contabiliza reincidencias e gera painel de multa ao atingir 3 notificacoes.</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant={settings.enabled ? "success" : "muted"}>{settings.enabled ? "Ativo" : "Inativo"}</Badge>
              <Switch checked={settings.enabled} disabled={disabled} onCheckedChange={(checked) => patch("enabled", checked)} />
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <FivemResourceMultiSelect
              disabled={disabled}
              label="Cargos que podem usar /notificar"
              onChange={(allowedRoleIds) => patch("allowedRoleIds", allowedRoleIds)}
              options={roleOptions}
              prefix="@"
              values={settings.allowedRoleIds}
            />

            <div className="grid gap-4">
              <FivemResourceSelect disabled={disabled} label="Cargo mencionado na multa" onChange={(fineRoleId) => patch("fineRoleId", fineRoleId)} options={roleOptions} prefix="@" value={settings.fineRoleId} />
              <FivemResourceSelect disabled={disabled} label="Canal do painel de multa" onChange={(fineChannelId) => patch("fineChannelId", fineChannelId)} options={channelOptions} prefix="#" value={settings.fineChannelId} />
              <FivemResourceSelect disabled={disabled} label="Canal de justificativa" onChange={(justificationChannelId) => patch("justificationChannelId", justificationChannelId)} options={channelOptions} prefix="#" value={settings.justificationChannelId} />
              <FivemResourceSelect disabled={disabled} label="Canal de logs" onChange={(logChannelId) => patch("logChannelId", logChannelId)} options={channelOptions} prefix="#" value={settings.logChannelId} />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-2 text-sm">
              <span className="flex items-center gap-2 font-medium text-zinc-200"><ImageIcon className="h-4 w-4 text-zinc-400" />Banner da DM</span>
              <input className="h-11 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition focus:border-emerald-500/60" disabled={disabled} onChange={(event) => patch("dmBannerUrl", event.target.value)} placeholder="https://..." value={settings.dmBannerUrl ?? ""} />
            </label>

            <label className="grid gap-2 text-sm">
              <span className="flex items-center gap-2 font-medium text-zinc-200"><ImageIcon className="h-4 w-4 text-zinc-400" />Banner do painel de multa</span>
              <input className="h-11 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition focus:border-emerald-500/60" disabled={disabled} onChange={(event) => patch("fineBannerUrl", event.target.value)} placeholder="https://..." value={settings.fineBannerUrl ?? ""} />
            </label>
          </div>

          <label className="grid gap-2 text-sm">
            <span className="flex items-center gap-2 font-medium text-zinc-200"><ShieldCheck className="h-4 w-4 text-zinc-400" />Gatilho da multa</span>
            <select className="h-11 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition focus:border-emerald-500/60" disabled={disabled} onChange={(event) => patch("fineMode", event.target.value as OpenPointSettings["fineMode"])} value={settings.fineMode}>
              <option value="once_at_3">Gerar apenas ao chegar em 3 notificacoes</option>
              <option value="every_after_3">Gerar em toda notificacao a partir da terceira</option>
            </select>
          </label>

          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-900 pt-4">
            <Button disabled={disabled} onClick={() => save()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Salvar configuracao
            </Button>
            {loading ? <span className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Carregando...</span> : null}
          </div>

          {status ? <p className="text-xs text-emerald-400">{status}</p> : null}
          {error ? <p className="text-xs text-red-400">{error}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function normalizeUrl(value: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readErrorMessage(error: unknown, fallback: string) {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return fallback;
  }

  const response = (error as { response?: { data?: { message?: unknown } } }).response;
  return typeof response?.data?.message === "string" ? response.data.message : fallback;
}
