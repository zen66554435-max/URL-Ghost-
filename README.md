# Site Crawler

واجهة ويب بسيطة لفحص موقع واكتشاف الصفحات والروابط الداخلية.

## تشغيل محلياً

```bash
npm install
npm start
```

ثم افتح:
http://localhost:3000

## Render

1. ارفع المشروع إلى GitHub.
2. في Render اختر **New → Web Service**.
3. اربط المستودع.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. اترك Node 20+.

يوجد `render.yaml` جاهز أيضاً.

## ملاحظات

- الزحف يبقى داخل نفس الـhostname.
- يدعم اكتشاف `sitemap.xml` وملفات sitemap المشار إليها في `robots.txt`.
- يقرأ روابط HTML العادية وcanonical وhreflang.
- لا يزحف إلى ملفات الصور/CSS/JS كصفحات.
- يطبق concurrency وdelay لتخفيف الضغط على الموقع الهدف.
- يحترم `robots.txt` افتراضياً.
- حد افتراضي 1000 صفحة لكل عملية، ويمكن تغييره من الواجهة.
