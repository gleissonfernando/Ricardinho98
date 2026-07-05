import { useEffect, useState } from "react";
import { Loader2, Save, Trash2 } from "lucide-react";
import { getDmDashboard, getGuildLiveOptions, getSummonsDashboard, removePanelImage, saveDmDashboard, saveSummonsDashboard, uploadPanelImage } from "../../lib/api";
import type { DashboardGuild, DmDashboard, GuildCategoryOption, GuildChannelOption, GuildRoleOption, SummonsDashboard } from "../../types";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Switch } from "../ui/switch";
import { FivemResourceMultiSelect, FivemResourceSelect } from "../fivem/FivemResourceSelect";

export function CommunicationPanel({ type, botId, guild, canManage }: { type: "dm" | "summons"; botId?: string | null; guild: DashboardGuild | null; canManage: boolean }) {
  const [data, setData] = useState<DmDashboard | SummonsDashboard | null>(null);
  const [channels, setChannels] = useState<GuildChannelOption[]>([]);
  const [categories, setCategories] = useState<GuildCategoryOption[]>([]);
  const [roles, setRoles] = useState<GuildRoleOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!botId || !guild) return;
    setData(null);
    Promise.all([type === "dm" ? getDmDashboard(guild.id, botId) : getSummonsDashboard(guild.id, botId), getGuildLiveOptions(guild.id, botId)])
      .then(([dashboard, options]) => { setData(dashboard); setChannels(options.channels); setCategories(options.categories ?? []); setRoles(options.roles); })
      .catch((error) => setMessage(readMessage(error)));
  }, [botId, guild?.id, type]);

  if (!botId || !guild) return <Empty text="Selecione um bot e um servidor." />;
  if (!data) return <Empty text="Carregando configurações..." loading />;
  const settings: any = data.settings;
  const patch = (value: object) => setData((current: any) => current ? { ...current, settings: { ...current.settings, ...value } } : current);
  const save = async () => { setBusy(true); setMessage(null); try { const next = type === "dm" ? await saveDmDashboard(guild.id, botId, settings) : await saveSummonsDashboard(guild.id, botId, settings); patch(next); setMessage("Configurações salvas."); } catch (error) { setMessage(readMessage(error)); } finally { setBusy(false); } };
  const upload = async (file: File, target: "bannerUrl" | "imageUrl" = "bannerUrl") => { setBusy(true); try { const result = await uploadPanelImage(guild.id, type === "dm" ? "dm-system" : "summons-system", file, botId); patch({ [target]: result.imageUrl, ...(type === "dm" && settings.imagePosition === "none" ? { imagePosition: "top" } : {}) }); setMessage(`${target === "bannerUrl" ? "Banner" : "Imagem"} enviado. Salve para aplicar.`); } catch (error) { setMessage(readMessage(error)); } finally { setBusy(false); } };
  const removeDmImage = async () => { setBusy(true); setMessage(null); try { await removePanelImage(guild.id, "dm-system", botId); patch({ imageUrl: null, imagePosition: "none" }); setMessage("Imagem removida. Salve para aplicar."); } catch (error) { setMessage(readMessage(error)); } finally { setBusy(false); } };

  return <div className="space-y-5">
    <Card><CardHeader><CardTitle>{type === "dm" ? "Configuração de DM" : "Sistema de Intimação"}</CardTitle><CardDescription>Configuração integrada com o bot e preview em tempo real.</CardDescription></CardHeader></Card>
    {message ? <div className="rounded-md border border-zinc-700 bg-zinc-900 p-3 text-sm">{message}</div> : null}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card><CardHeader><CardTitle>Configuração</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
        <label className="flex items-center gap-2 text-sm"><Switch checked={settings.enabled} disabled={!canManage} onCheckedChange={(enabled) => patch({ enabled })} />Sistema ativo</label>
        <label className="text-sm">Cor<input type="color" className="mt-2 h-11 w-full rounded-md border border-zinc-800 bg-black p-1" value={settings.color} disabled={!canManage} onChange={(event) => patch({ color: event.target.value })} /></label>
        {type === "dm" ? <>
          <label className="text-sm">Título padrão<input maxLength={60} className="mt-2 h-11 w-full rounded-md border border-zinc-800 bg-black px-3" value={settings.defaultTitle} disabled={!canManage} onChange={(event) => patch({ defaultTitle: event.target.value })} /></label>
          <label className="text-sm">Rodapé<input className="mt-2 h-11 w-full rounded-md border border-zinc-800 bg-black px-3" value={settings.footerText ?? ""} disabled={!canManage} onChange={(event) => patch({ footerText: event.target.value || null })} /></label>
          <label className="md:col-span-2 text-sm">Mensagem padrão<textarea maxLength={300} className="mt-2 min-h-28 w-full rounded-md border border-zinc-800 bg-black p-3" value={settings.defaultText} disabled={!canManage} onChange={(event) => patch({ defaultText: event.target.value })} /></label>
          <FivemResourceSelect label="Canal de logs" options={channels} value={settings.logChannelId} disabled={!canManage} onChange={(logChannelId) => patch({ logChannelId })} />
          <label className="flex items-center gap-2 text-sm"><Switch checked={settings.blockBots ?? true} disabled={!canManage} onCheckedChange={(blockBots) => patch({ blockBots })} />Bloquear envio para bots</label>
          <label className="text-sm">Imagem da DM<input className="mt-2 h-11 w-full rounded-md border border-zinc-800 bg-black px-3" placeholder="https:// ou upload abaixo" value={settings.imageUrl ?? ""} disabled={!canManage} onChange={(event) => patch({ imageUrl: event.target.value || null })} /></label>
          <label className="text-sm">Posição da imagem<select className="mt-2 h-11 w-full rounded-md border border-zinc-800 bg-black px-3" value={settings.imagePosition ?? "top"} disabled={!canManage} onChange={(event) => patch({ imagePosition: event.target.value })}><option value="none">Sem imagem</option><option value="top">Imagem no topo</option><option value="footer">Imagem no rodapé</option><option value="side">Imagem na lateral</option><option value="thumbnail">Thumbnail pequena</option><option value="banner">Banner grande</option></select></label>
        </> : <>
          <FivemResourceSelect label="Categoria principal" options={categories} value={settings.categoryId} disabled={!canManage} onChange={(categoryId) => patch({ categoryId })} />
          <FivemResourceSelect label="Categoria temporária" options={categories} value={settings.temporaryCategoryId} disabled={!canManage} onChange={(temporaryCategoryId) => patch({ temporaryCategoryId })} />
          <FivemResourceSelect label="Canal privado de logs" options={channels} value={settings.logChannelId} disabled={!canManage} onChange={(logChannelId) => patch({ logChannelId })} />
          <label className="md:col-span-2 text-sm">Banner da DM<input className="mt-2 h-11 w-full rounded-md border border-zinc-800 bg-black px-3" placeholder="https:// ou upload abaixo" value={settings.bannerUrl ?? ""} disabled={!canManage} onChange={(event) => patch({ bannerUrl: event.target.value || null })} /></label>
          <label className="text-sm">Exclusão após finalizar (s)<input type="number" min={3} max={86400} className="mt-2 h-11 w-full rounded-md border border-zinc-800 bg-black px-3" value={settings.deleteDelaySeconds} disabled={!canManage} onChange={(event) => patch({ deleteDelaySeconds: Number(event.target.value) })} /></label>
          <label className="flex items-center gap-2 text-sm"><Switch checked={settings.transcriptEnabled} disabled={!canManage} onCheckedChange={(transcriptEnabled) => patch({ transcriptEnabled })} />Salvar transcript</label>
        </>}
        {type === "dm" ? <FivemResourceMultiSelect label="Cargos que podem usar /dm" options={roles} values={settings.authorizedRoleIds} disabled={!canManage} onChange={(authorizedRoleIds) => patch({ authorizedRoleIds })} /> : <RolePicker label="Cargos que podem criar intimações" roles={roles} value={settings.authorizedRoleIds} disabled={!canManage} onChange={(authorizedRoleIds) => patch({ authorizedRoleIds })} />}
        {type === "summons" ? <RolePicker label="Cargos que gerenciam, finalizam, cancelam e acessam logs" roles={roles} value={settings.moderatorRoleIds} disabled={!canManage} onChange={(moderatorRoleIds) => patch({ moderatorRoleIds })} /> : null}
        {type === "summons" ? <label className="text-sm">Upload de banner<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="mt-2 block w-full rounded-md border border-zinc-800 bg-black p-2" disabled={!canManage || busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file, "bannerUrl"); }} /></label> : null}
        {type === "dm" ? <><label className="text-sm">Upload da imagem<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="mt-2 block w-full rounded-md border border-zinc-800 bg-black p-2" disabled={!canManage || busy} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void upload(file, "imageUrl"); }} /></label><div className="flex items-end"><Button disabled={!canManage || busy || !settings.imageUrl} onClick={() => void removeDmImage()} variant="outline"><Trash2 className="h-4 w-4" />Remover imagem</Button></div></> : null}
        <div className="md:col-span-2 flex justify-end"><Button disabled={!canManage || busy} onClick={() => void save()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Salvar</Button></div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Preview</CardTitle></CardHeader><CardContent>{type === "dm" ? <DmPreview guildName={guild.name} settings={settings} /> : <SummonsPreview settings={settings} />}</CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle>Logs recentes</CardTitle></CardHeader><CardContent className="space-y-2">{(type === "dm" ? (data as DmDashboard).logs : (data as SummonsDashboard).history).slice(0, 20).map((item: any) => <div key={item.id} className="flex justify-between gap-3 border-b border-zinc-800 py-2 text-sm"><span>{type === "dm" ? `${item.title} → ${item.targetId}` : `${item.reason} → ${item.targetId}`}</span><span className="text-zinc-500">{item.status}</span></div>)}</CardContent></Card>
  </div>;
}

function RolePicker({ label, roles, value, disabled, onChange }: { label: string; roles: GuildRoleOption[]; value: string[]; disabled: boolean; onChange: (value: string[]) => void }) { return <label className="text-sm">{label}<select multiple className="mt-2 min-h-28 w-full rounded-md border border-zinc-800 bg-black p-2" value={value} disabled={disabled} onChange={(event) => onChange([...event.target.selectedOptions].map((option) => option.value))}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>; }
function DmPreview({ guildName, settings }: { guildName: string; settings: any }) {
  const showImage = Boolean(settings.imageUrl) && settings.imagePosition !== "none";
  const image = showImage ? <img alt="Preview da imagem da DM" className={settings.imagePosition === "banner" ? "aspect-[16/6] w-full object-cover" : settings.imagePosition === "thumbnail" ? "h-20 w-20 rounded object-cover" : settings.imagePosition === "side" ? "h-28 w-28 rounded object-cover" : "max-h-52 w-full rounded object-cover"} src={settings.imageUrl} /> : null;
  const body = <div className="min-w-0 flex-1 p-4"><p className="font-semibold text-white">📩 Mensagem da equipe</p><div className="mt-3 text-sm text-zinc-200"><p className="font-semibold">Título:</p><p>{settings.defaultTitle}</p><p className="mt-3 font-semibold">Mensagem:</p><p className="whitespace-pre-wrap">{settings.defaultText}</p></div><p className="mt-4 border-t border-zinc-600 pt-3 text-xs text-zinc-400">Enviado por: Equipe {guildName}</p>{settings.footerText ? <p className="mt-1 text-xs text-zinc-500">{settings.footerText}</p> : null}</div>;
  return <div className="overflow-hidden rounded-md border border-zinc-700 bg-[#313338]" style={{ borderLeftColor: settings.color, borderLeftWidth: 4 }}>
    {showImage && ["top", "banner"].includes(settings.imagePosition) ? image : null}
    {showImage && ["side", "thumbnail"].includes(settings.imagePosition) ? <div className="flex items-start gap-3">{body}<div className="p-4 pl-0">{image}</div></div> : body}
    {showImage && settings.imagePosition === "footer" ? <div className="px-4 pb-4">{image}</div> : null}
  </div>;
}
function SummonsPreview({ settings }: { settings: any }) {
  return <div className="space-y-4">
    <div className="overflow-hidden rounded-md border border-zinc-700 bg-[#313338]" style={{ borderLeftColor: settings.color, borderLeftWidth: 4 }}>
      {settings.bannerUrl ? <img alt="Banner da DM" className="aspect-[16/6] w-full object-cover" src={settings.bannerUrl} /> : null}
      <div className="p-4"><p className="font-semibold text-white">📨 Solicitação da Equipe AB</p><p className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">A Equipe AB está solicitando sua presença para uma conversa.</p><p className="mt-3 text-sm text-zinc-300"><b>Mensagem:</b> descrição preenchida pelo staff</p><p className="mt-3 text-sm text-zinc-300"><b>Canal:</b> #conversa-usuario</p><p className="text-sm text-zinc-300"><b>Equipe:</b> Equipe AB</p><button className="mt-4 rounded bg-[#5865f2] px-3 py-2 text-sm text-white">🔗 Acessar conversa</button></div>
    </div>
    <div className="rounded-md border border-zinc-700 bg-[#313338] p-4" style={{ borderLeftColor: settings.color, borderLeftWidth: 4 }}><p className="font-semibold text-white">🔒 Conversa confidencial aberta</p><p className="mt-2 text-sm text-zinc-300">Este canal é confidencial e destinado à conversa com a Equipe AB.</p><p className="mt-3 text-sm text-zinc-300"><b>Intimado:</b> @usuário</p><p className="text-sm text-zinc-300"><b>Status:</b> Aguardando resposta</p><p className="text-sm text-zinc-300"><b>Responsável:</b> Equipe AB</p></div>
  </div>;
}
function Empty({ text, loading = false }: { text: string; loading?: boolean }) { return <Card><CardContent className="flex min-h-48 items-center justify-center gap-2 text-zinc-400">{loading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}{text}</CardContent></Card>; }
function readMessage(error: unknown) { return (error as any)?.response?.data?.message ?? "Não foi possível concluir a operação."; }
