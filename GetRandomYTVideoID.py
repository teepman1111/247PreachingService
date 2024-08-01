import random
from nested_lookup import nested_lookup
from google.cloud import firestore
import firebase_admin
from firebase_admin import credentials
import streamlit as st
cred = credentials.ApplicationDefault()
app = firebase_admin.initialize_app(cred)
db = firestore.Client(project='preaching247-b6740')

def main():
    collection = db.collection('YTVids').stream()
    xlist = []
    for x in collection:
        xdict = x.to_dict()
        xvalues = random.choice(list(xdict.values()))
        xlist.append(xvalues)
    randomytvidid = random.choice(list(xlist))

    urlbase = 'https://youtu.be/'
    url = urlbase + randomytvidid
    return url


if __name__ == "__main__":
    main()