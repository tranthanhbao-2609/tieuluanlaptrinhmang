import User from "../models/user.model.js";
import Message from "../models/message.model.js";

import cloudinary from "../lib/cloudinary.js";
import { getReceiverSocketId, io } from "../lib/socket.js";

// ====================== Người dùng & Tin nhắn ======================
export const getUsersForSidebar = async (req, res) => {
  try {
    const loggedInUserId = req.user._id;
    const filteredUsers = await User.find({ _id: { $ne: loggedInUserId } }).select("-password");
    res.status(200).json(filteredUsers);
  } catch (error) {
    console.error("Lỗi ở getUsersForSidebar: ", error.message);
    res.status(500).json({ error: "Lỗi server nội bộ" });
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
    console.log("Lỗi ở getMessages controller: ", error.message);
    res.status(500).json({ error: "Lỗi server nội bộ" });
  }
};

// ====================== Pipeline kiểm duyệt ======================

const HF_API_KEY = process.env.HF_API_KEY;
const HF_TRANSLATION_MODEL = process.env.HF_TRANSLATION_MODEL || "facebook/mbart-large-50-many-to-many-mmt";
const HF_TOXIC_MODEL = process.env.HF_TOXIC_MODEL || "unitary/unbiased-toxic-roberta";

const MODERATION_ACTION = process.env.MODERATION_ACTION || "block";
const THRESHOLD = parseFloat(process.env.MODERATION_THRESHOLD || "0.6");
const MODERATION_NOTICE_TEMPLATE =
  process.env.MODERATION_NOTICE_TEMPLATE ||
  'Cảnh báo: tin nhắn bị đánh dấu: {{label}} ({{score_percent}}%). EN: "{{english}}".';

const HF_API_URL = (model) =>
  `https://router.huggingface.co/hf-inference/models/${encodeURIComponent(model)}`;

async function callHFModel(model, payload) {
  if (!HF_API_KEY) throw new Error("HF_API_KEY bị thiếu");

  const res = await fetch(HF_API_URL(model), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  console.log(`HF debug - model: ${model} trạng thái:`, res.status, "body:", raw);

  if (!res.ok) throw new Error(`Lỗi HF ${res.status}: ${raw}`);

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Hàm đoán ngôn ngữ của tin nhắn
function guessMBartLang(text) {
  if (!text) return "en_XX";
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text)) return "vi_VN";
  if (/[\u3040-\u30FF]/.test(text)) return "ja_XX";
  if (/[\u1100-\u11FF\uAC00-\uD7AF]/.test(text)) return "ko_KR";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh_CN";
  if (/[\u0400-\u04FF]/.test(text)) return "ru_RU";
  if (/[\u0E00-\u0E7F]/.test(text)) return "th_TH";
  return "en_XX";
}

// ====================== Hàm dịch mọi ngôn ngữ sang EN ======================
export async function translateAnyToEn(text) {
  if (!text) return { english: "", raw: null };
  const srcLang = guessMBartLang(text);
  const tgtLang = "en_XX";

  if (srcLang === "en_XX") return { english: text, raw: null, skipped: true, srcLang, tgtLang };

  try {
    const data = await callHFModel(HF_TRANSLATION_MODEL, {
      inputs: text,
      parameters: { src_lang: srcLang, tgt_lang: tgtLang },
    });

    let english = text;
    if (typeof data === "string") english = data;
    else if (Array.isArray(data)) {
      const first = data[0];
      if (typeof first === "string") english = first;
      else if (first?.translation_text) english = first.translation_text;
    }

    return { english, raw: data, srcLang, tgtLang };
  } catch (err) {
    console.warn("Lỗi dịch:", err.message || err);
    return { english: text, raw: null, error: err.message, srcLang, tgtLang };
  }
}

// ====================== Hàm kiểm duyệt nội dung toxic ======================
async function moderateEnglishToxic(englishText) {
  if (!englishText) return { flagged: false };
  try {
    const data = await callHFModel(HF_TOXIC_MODEL, { inputs: englishText });

    let scores;
    if (Array.isArray(data)) scores = Array.isArray(data[0]) ? data[0] : data;
    else if (Array.isArray(data?.labels) && Array.isArray(data?.scores))
      scores = data.labels.map((label, i) => ({ label, score: data.scores[i] }));
    else return { flagged: false, raw: data };

    const toxicLabels = ["toxic","severe_toxic","obscene","threat","insult","identity_hate","toxicity","severe_toxicity","identity_attack","sexual_explicit"];
    const triggered = scores.filter(s => toxicLabels.includes(s.label.toLowerCase()) && s.score >= THRESHOLD);
    const max = scores.reduce((m, s) => (s.score > m.score ? s : m), { score: 0, label: null });

    return { flagged: triggered.length > 0, label: max.label, score: max.score, scores, raw: data };
  } catch (err) {
    console.warn("Ngoại lệ kiểm duyệt toxic:", err);
    return { flagged: false, error: err.message };
  }
}

// ====================== Hàm kiểm duyệt tin nhắn ======================
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

// ====================== Gửi tin nhắn ======================
export const sendMessage = async (req, res) => {
  try {
    const { text, image } = req.body;
    const { id: receiverId } = req.params;
    const senderId = req.user._id;

    console.log("HF_API_KEY =", HF_API_KEY);

    // === TÍNH NĂNG DỊCH THEO YÊU CẦU CỦA NGƯỜI DÙNG ===
    if (text && text.trim().toUpperCase() === "EN") {
      const lastMessage = await Message.findOne({
        senderId,
        receiverId,
        text: { $ne: "EN" } // tránh dịch chữ EN
      }).sort({ createdAt: -1 });

      if (!lastMessage) {
        return res.status(400).json({ error: "Không có tin nhắn nào để dịch." });
      }

      const translation = await translateAnyToEn(lastMessage.text);

      const translatedMsg = new Message({
        senderId,
        receiverId,
        text: `Dịch sang EN:\n${translation.english}`,
      });

      await translatedMsg.save();

      const receiverSocketId = getReceiverSocketId(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("newMessage", translatedMsg);
      }

      return res.status(201).json(translatedMsg);
    }

    // === KIỂM DUYỆT + GỬI TIN NHẮN THƯỜNG ===
    let finalText = text;
    if (text) {
      const mod = await moderateText(text);
      console.log("Kết quả kiểm duyệt:", mod);

      if (mod.flagged) {
        if (MODERATION_ACTION === "block") {
          return res.status(403).json({ error: "Tin nhắn bị chặn do kiểm duyệt", detail: mod });
        } else if (MODERATION_ACTION === "sanitize") {
          finalText = "[Tin nhắn bị loại bỏ bởi bộ lọc]";
        } else if (MODERATION_ACTION === "allow_with_notice") {
          const scorePercent = mod.score ? Math.round(mod.score * 100) : 0;
          const tplParams = { label: mod.label ?? "flagged", score: mod.score ?? 0, score_percent: scorePercent, original: text ?? "", english: mod.english ?? "" };
          const notice = formatTemplate(MODERATION_NOTICE_TEMPLATE, tplParams);
          finalText = `${text}\n\n${notice}`;
        }
      }
    }

    // Upload ảnh nếu có
    let imageUrl;
    if (image) {
      const uploadResponse = await cloudinary.uploader.upload(image);
      imageUrl = uploadResponse.secure_url;
    }

    const newMessage = new Message({
      senderId,
      receiverId,
      text: finalText,
      image: imageUrl,
    });

    await newMessage.save();

    const receiverSocketId = getReceiverSocketId(receiverId);
    console.log("Gửi tới socketId:", receiverSocketId, "tin nhắn:", newMessage);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", newMessage);
    }

    res.status(201).json(newMessage);

  } catch (error) {
    console.log("Lỗi ở sendMessage controller: ", error.message);
    res.status(500).json({ error: "Lỗi server nội bộ" });
  }
};

// ====================== Helper ======================
function formatTemplate(template, params = {}) {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (m, key) => {
    const val = params[key.trim()];
    return val === undefined || val === null ? "" : String(val);
  });
}
