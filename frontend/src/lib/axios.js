import axios from "axios";

export const axiosInstance = axios.create({
  baseURL: import.meta.env.MODE === "development" ? "tranthanhbao-2609/baitap3chuong7/api" : "/api",
  withCredentials: true,
});
