import axios from "axios";

export const axiosInstance = axios.create({
  baseURL: import.meta.env.MODE === "development" ? "https://tieuluanlaptrinhmang.onrender.com/api" : "/api",
api" : "/api",
  withCredentials: true,
});
