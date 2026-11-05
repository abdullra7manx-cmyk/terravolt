# من B1 إلى B3: سيرفرات BLOCKFALL 3001

لانشر BLOCKFALL صار يقرأ `premium_account.json` من مجلد `.terravolt` ويستخدم `username` اسماً للاعب.

نظام السيرفرات الجديد يخزّن بياناته في Firestore حق Premium Studio، في collection جديدة اسمها `bfServers`. عشان يشتغل نحتاج منك شيئين:

## 1) إضافة توكن الدخول إلى premium_account.json

أضف للملف اللي يكتبه `writeBfAccount()` هذين الحقلين:

- `uid`: قيمة `auth.currentUser.uid`.
- `refreshToken`: قيمة `auth.currentUser.refreshToken`، وهو Firebase refresh token العادي.

اللانشر يحوّل التوكن بنفسه إلى idToken عن طريق `securetoken.googleapis.com` ويستخدمه مع Firestore REST.

مهم: حدّث الملف كل ما تغيّر المستخدم أو سوّى تسجيل خروج، واحذفه عند الخروج (هذا موجود عندك أصلاً).

إذا ما كان فيه توكن، اللانشر يعرض تسجيل دخول بالإيميل وكلمة السر كحل احتياطي.

## 2) قواعد Firestore

الصق محتوى `bfServers.rules` داخل `match /databases/{database}/documents { ... }` في `firestore.rules`، ثم سوّ deploy.

القواعد تستخدم دوال موجودة عندك: `signedIn()` و`isAdmin()` و`changed()`.

## شكل البيانات (للمعلومية)

`bfServers/{id}` فيه الحقول التالية:

- **معلومات السيرفر:** `name`, `desc`, `code` (8 حروف وهو رمز الدخول), `public`, `max`, `mode`, `seed`.
- **المالك:** `owner` (uid), `ownerName`.
- **الفريق:**
  - `members`: خريطة من uid إلى `{name, role, at}`، والرتب `owner|admin|mod|member`.
  - `memberIds`: مصفوفة بالـuid.
- **الخطة:** `plan` (`free|paid`) و`paidUntil`. ما يغيّرهما إلا الأدمن، وهي للسيرفرات المدفوعة لاحقاً.
- **الاستضافة:** `host`، وفيه `{uid, name, beat, players, list, ver}` أو null.
- **العالم:**
  - `worldVer`, `worldSize`, `worldParts`, `bans`, `created`, `updated`.
  - المجموعة الفرعية `world/{n}`، وكل جزء فيها `{d: base64 gzip, v}`.

الخطة الفعلية تكون مدفوعة فقط إذا `plan=='paid'` و`paidUntil` بعد الوقت الحالي، وغير كذا يُعامل السيرفر كمجاني.

## اقتراح لاحقاً

في المتجر، تقدر تعرض «سيرفراتي» من نفس الـcollection. الاستعلام: `memberIds array-contains uid`.
