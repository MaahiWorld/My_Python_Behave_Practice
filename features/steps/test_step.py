from behave import given, when, then
import pandas as pd

@given('the source document "{source_doc}" have records')
def load_source_data(context,source_doc):
    context.source_df=pd.read_csv(fr'C:\Users\Hp\Python_BDD_Practice\input_files\{source_doc}')
    context.source_count=len(context.source_df)

@when('the data in target document "{target_doc}" is loaded')    
def load_target_data(context,target_doc):
    context.target_df=pd.read_csv(fr'C:\Users\Hp\Python_BDD_Practice\input_files\{target_doc}')
    context.target_count=len(context.target_df)

@then('the count between source document and target document should match') 
def count_comparison(context):
    assert context.target_count==context.source_count   