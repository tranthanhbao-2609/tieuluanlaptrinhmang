import express from "express";
import { checkAuth, login, logout, signup, updateProfile } from "../controllers/auth.controller.js";
import { protectRoute } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);
router.post("/logout", logout);

router.put("/update-profile", protectRoute, updateProfile);
// Note: Removed client-side FormData/axios calls that were mistakenly
// placed in this server route file. Client requests should be made from
// the frontend; routes here should only register Express handlers.
router.get("/check", protectRoute, checkAuth);

export default router;
