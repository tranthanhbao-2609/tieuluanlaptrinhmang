import axios from "axios";

export const axiosInstance = axios.create({
  baseURL: import.meta.env.MODE === "development" ? "https://tieuluanlaptrinhmangbacken.onrender.com/api" : "/api",
  withCredentials: true,
});
