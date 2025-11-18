import axios from "axios";

export const axiosInstance = axios.create({
  baseURL: "https://tieuluanlaptrinhmang.onrender.com/api",
  withCredentials: true,
});
