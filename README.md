# HRless

Claude Code'da yazı kutusunun üstüne bir **HRless** düğmesi ekler. Düğmeye basınca yerel bir sayfa açılır (http://127.0.0.1:4777) ve yalnız o oturumun agent ağacını gösterir: oturum en üstte, çağırdığı subagentlar altında, onların çağırdıkları bir alt kademede. Bir agent `agy -p` ya da `codex exec` çalıştırdıysa açılan agy/Codex konuşması da onun altında görünür.

## Kurulum

Terminalde bir Claude Code oturumunun yazı kutusuna:

```
/plugin install hrless --marketplace anilmai/HRless
```

`Add marketplace?` sorusuna `y` deyin, ardından kapsamı seçin (Enter, kullanıcı kapsamı).

Kabuktan:

```bash
claude plugin install hrless --marketplace anilmai/HRless
```

Masaüstü uygulamasında (`/plugin` çalışmadığında): yazı kutusunun yanındaki + > Plugins > Add marketplace ile `anilmai/HRless` ekleyin, sonra Add plugin.

Gereken: Node.js 22.5 veya üstü `PATH` içinde (agy konuşmaları `node:sqlite` ile okunur).

## Görünümler

- **Liste:** her agent bir kart; durum, son yaptığı iş, proje klasörü, model. Karta tıklayınca son istek ve son 8 adım açılır.
- **Grafik** (sağ üstteki ikon): her agent renkli bir top, orkestratör üstte, başlattığı agentlar kademe kademe altında. Sağdaki mini liste hangi rengin hangi agent türü olduğunu gösterir. Sürükleyerek kaydırın, tekerlekle yakınlaşın, topa tıklayınca ayrıntı açılır.
- **Bu oturum · tümünü gör:** düğmeyle açılan sayfa yalnız o oturumu gösterir; bu bağlantı makinedeki bütün oturumlara geçer.

## Nereden okur

| Araç | Dosyalar | Alt agentlar |
| --- | --- | --- |
| Claude Code (CLI ve masaüstü) | `~/.claude/projects/*/*.jsonl` | `<oturum>/subagents/agent-*.jsonl`, çağıran agente `toolUseId` ile bağlanır |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | `parent_thread_id` ile |
| agy (Antigravity CLI) | `~/.gemini/antigravity-cli/conversations/*.db` | `parent_references` ile |

agy ve Codex konuşmaları, başladıkları anda süren `agy`/`codex` Bash çağrısının sahibi olan Claude agentının altına bağlanır (zamana göre eşleşme; aynı anda birden çok çağrı varsa nadiren yanlış dala düşebilir).

Durum, dosyanın son yazılma zamanından çıkar: 90 saniye içinde **çalışıyor**, 30 dakika içinde **boşta**, daha eski **bitti**. Sayfa 3 saniyede bir yenilenir. Hiçbir şey dışarı gönderilmez; sunucu yalnız `127.0.0.1`'i dinler ve dosyaları yalnız okur.

## Elle çalıştırma

```bash
node server/server.js --open
```

Port `HRLESS_PORT` ile değişir. `CLAUDE_CONFIG_DIR` ve `CODEX_HOME` dikkate alınır. Sunucu kodunu değiştirdikten sonra çalışan eski sunucuyu kapatın, yoksa düğme eskisini açar (sayfa, `index.html`, her istekte yeniden okunur).

## Lisans

MIT
