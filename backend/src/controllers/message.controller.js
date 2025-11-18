import User from "../models/user.model.js";
import Message from "../models/message.model.js";

import cloudinary from "../lib/cloudinary.js";
import { getReceiverSocketId, io } from "../lib/socket.js";

export const getUsersForSidebar = async (req, res) => {
  try {
    const loggedInUserId = req.user._id;
    const filteredUsers = await User.find({ _id: { $ne: loggedInUserId } }).select("-password");

    res.status(200).json(filteredUsers);
  } catch (error) {
    console.error("Error in getUsersForSidebar: ", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getMessages = async (req, res) => {
  try {
    const { id: userToChatId } = req.params;
    const myId = req.user._id;

    const messages = await Message.find({
      $or: [
        { senderId: myId, receiverId: userToChatId },
        { senderId: userToChatId, receiverId: myId },
      ],
    });

    res.status(200).json(messages);
  } catch (error) {
    console.log("Error in getMessages controller: ", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// =====================================================================
//  Moderation pipeline đa ngôn ngữ:
//  1) Dịch mọi ngôn ngữ -> English (facebook/mbart-large-50-many-to-many-mmt)
//  2) Check toxic tiếng Anh (unitary/unbiased-toxic-roberta)
// =====================================================================

const HF_API_KEY = process.env.HF_API_KEY;

// Model dịch đa ngôn ngữ -> EN (có HF Inference API)
const HF_TRANSLATION_MODEL =
  process.env.HF_TRANSLATION_MODEL || "facebook/mbart-large-50-many-to-many-mmt";

// Model toxic tiếng Anh
const HF_TOXIC_MODEL =
  process.env.HF_TOXIC_MODEL || "unitary/unbiased-toxic-roberta";

// Hành vi khi flagged:
// - "block": trả 403, không lưu message
// - "sanitize": thay nội dung bằng placeholder
// - "allow_with_notice": vẫn gửi, thêm cảnh báo
const MODERATION_ACTION = process.env.MODERATION_ACTION || "block";

// Ngưỡng toxic cho model tiếng Anh
const THRESHOLD = parseFloat(process.env.MODERATION_THRESHOLD || "0.6");

// Template cảnh báo
const MODERATION_NOTICE_TEMPLATE =
  process.env.MODERATION_NOTICE_TEMPLATE ||
  'Warning: message flagged: {{label}} ({{score_percent}}%). EN: "{{english}}".';

// Endpoint router HF
const HF_API_URL = (model) =>
  `https://router.huggingface.co/hf-inference/models/${encodeURIComponent(
    model
  )}`;

// Nếu Node < 18 thì cần:
// import fetch from "node-fetch";
// globalThis.fetch = fetch;

// ---------------------------------------------------------------------
// Helper: call HF router cho 1 model
// ---------------------------------------------------------------------
async function callHFModel(model, payload) {
  if (!HF_API_KEY) {
    throw new Error("HF_API_KEY is missing");
  }

  const url = HF_API_URL(model);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  console.log(`HF debug - model: ${model} status:`, res.status, "body:", raw);

  if (!res.ok) {
    const err = new Error(`HF error ${res.status}: ${raw}`);
    err.status = res.status;
    err.raw = raw;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  return { data, raw, status: res.status };
}

// ---------------------------------------------------------------------
// Đoán lang-code cho mBART (50 languages)
// Chỉ cover 1 số ngôn ngữ phổ biến; còn lại default English
// ---------------------------------------------------------------------
function guessMBartLang(text) {
  if (!text) return "en_XX";

  // tiếng Việt: có dấu đặc trưng
  if (
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
      text
    )
  ) {
    return "vi_VN";
  }

  // Nhật: Hiragana / Katakana
  if (/[\u3040-\u30FF]/.test(text)) {
    return "ja_XX";
  }

  // Hàn: Hangul
  if (/[\u1100-\u11FF\uAC00-\uD7AF]/.test(text)) {
    return "ko_KR";
  }

  // Trung: CJK (chưa phân biệt Nhật/Trung tinh, nhưng cơ bản ổn)
  if (/[\u4E00-\u9FFF]/.test(text)) {
    return "zh_CN";
  }

  // Nga & Slavic: Cyrillic
  if (/[\u0400-\u04FF]/.test(text)) {
    return "ru_RU";
  }

  // Thái
  if (/[\u0E00-\u0E7F]/.test(text)) {
    return "th_TH";
  }

  // Mặc định: English / Latin script khác
  return "en_XX";
}

// ---------------------------------------------------------------------
// Bước 1: Dịch "bất kỳ ngôn ngữ" -> English với mBART-50
// ---------------------------------------------------------------------
async function translateAnyToEn(text) {
  if (!text) {
    return { english: "", raw: null };
  }

  const srcLang = guessMBartLang(text);
  const tgtLang = "en_XX";

  // Nếu đã là tiếng Anh (hoặc coi như English) thì KHÔNG dịch nữa
  if (srcLang === "en_XX") {
    return {
      english: text,
      raw: null,
      srcLang,
      tgtLang,
      skipped: true,
    };
  }

  try {
    const { data } = await callHFModel(HF_TRANSLATION_MODEL, {
      inputs: text,
      parameters: {
        src_lang: srcLang,
        tgt_lang: tgtLang,
      },
    });

    let english = text; // fallback = giữ nguyên

    if (typeof data === "string") {
      english = data;
    } else if (Array.isArray(data)) {
      const first = data[0];
      if (typeof first === "string") {
        english = first;
      } else if (first && typeof first.translation_text === "string") {
        english = first.translation_text;
      } else if (Array.isArray(first) && first[0]?.translation_text) {
        english = first[0].translation_text;
      }
    }

    return { english, raw: data, srcLang, tgtLang };
  } catch (err) {
    console.warn("Translation error:", err.message || err);
    // Nếu dịch lỗi, vẫn trả về bản gốc để còn xử lý tiếp
    return { english: text, raw: null, error: err.message, srcLang, tgtLang };
  }
}

// ---------------------------------------------------------------------
// Bước 2: Check toxic trên tiếng Anh bằng unitary/unbiased-toxic-roberta
// ---------------------------------------------------------------------
async function moderateEnglishToxic(englishText) {
  if (!englishText) return { flagged: false };

  try {
    const { data } = await callHFModel(HF_TOXIC_MODEL, {
      inputs: englishText,
    });

    // Thường: [{ label, score }, ...] hoặc [[{ label, score }, ...]]
    let scores;

    if (Array.isArray(data)) {
      if (Array.isArray(data[0])) {
        scores = data[0];
      } else {
        scores = data;
      }
    } else if (
      Array.isArray(data?.labels) &&
      Array.isArray(data?.scores)
    ) {
      scores = data.labels.map((label, i) => ({
        label,
        score: data.scores[i],
      }));
    } else {
      console.warn("Toxic model: unexpected response format", data);
      return { flagged: false, raw: data };
    }

    const toxicLabels = [
      "toxic",
      "severe_toxic",
      "obscene",
      "threat",
      "insult",
      "identity_hate",
      "toxicity",
      "severe_toxicity",
      "identity_attack",
      "sexual_explicit",
    ];

    const triggered = scores.filter(
      (s) =>
        toxicLabels.includes(s.label.toLowerCase()) &&
        s.score >= THRESHOLD
    );

    const max = scores.reduce(
      (m, s) => (s.score > m.score ? s : m),
      { score: 0, label: null }
    );

    return {
      flagged: triggered.length > 0,
      label: max.label,
      score: max.score,
      scores,
      raw: data,
    };
  } catch (err) {
    console.warn("Toxic moderation exception:", err);
    return { flagged: false, error: err.message };
  }
}

// ---------------------------------------------------------------------
// Gộp lại: moderateText đa ngôn ngữ -> EN -> toxic EN
// ---------------------------------------------------------------------
async function moderateText(text) {
  if (!HF_API_KEY || !text) return { flagged: false };

  const translation = await translateAnyToEn(text);
  const english = translation.english || text;

  const toxic = await moderateEnglishToxic(english);

  return {
    flagged: toxic.flagged,
    label: toxic.label,
    score: toxic.score,
    english,
    translationRaw: translation.raw,
    toxicRaw: toxic.raw,
  };
}
//2025/11/16 Chanhnd add end

export const sendMessage = async (req, res) => {
  try {
    const { text, image } = req.body;
    const { id: receiverId } = req.params;
    const senderId = req.user._id;

    //2025/11/16 Chanhnd add start
    // Moderation trước khi lưu
    if (text) {
      const mod = await moderateText(text);

      if (mod.flagged) {
        if (MODERATION_ACTION === "block") {
          return res
            .status(403)
            .json({ error: "Message blocked by moderation", detail: mod });
        } else if (MODERATION_ACTION === "sanitize") {
          req.body.text = "[Message removed by moderator]";
        } else if (MODERATION_ACTION === "allow_with_notice") {
          const scorePercent = mod.score ? Math.round(mod.score * 100) : 0;
          const tplParams = {
            label: mod.label ?? "flagged",
            score: mod.score ?? 0,
            score_percent: scorePercent,
            original: text ?? "",
            english: mod.english ?? "",
          };

          const notice = formatTemplate(MODERATION_NOTICE_TEMPLATE, tplParams);

          req.body.text = `${text}\n\n${notice}`;
        }
      }
    }
    //2025/11/16 Chanhnd add end

    let imageUrl;
    if (image) {
      const uploadResponse = await cloudinary.uploader.upload(image);
      imageUrl = uploadResponse.secure_url;
    }

    const newMessage = new Message({
      senderId,
      receiverId,
      //2025/11/16 Chanhnd edit start
      //text: text,
      text: req.body.text ?? text,
      //2025/11/16 Chanhnd edit end
      image: imageUrl,
    });

    await newMessage.save();

    const receiverSocketId = getReceiverSocketId(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", newMessage);
    }

    res.status(201).json(newMessage);
  } catch (error) {
    console.log("Error in sendMessage controller: ", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// simple template formatter: replaces {{key}} with params[key]
function formatTemplate(template, params = {}) {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (m, key) => {
    const val = params[key.trim()];
    return val === undefined || val === null ? "" : String(val);
  });
}
