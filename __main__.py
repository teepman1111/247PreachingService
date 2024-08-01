import GetRandomYTVideoID as base
import streamlit as st

url = base.main()

st.title('24/7 Preaching')
st.video(url)
