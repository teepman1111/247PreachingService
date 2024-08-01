import GetRandomYTVideoID as base
import streamlit as st
import streamlit.components.v1 as stv1

url = base.main()
print(url)


st.title('24/7 Preaching')
st.video(url)
