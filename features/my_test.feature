Feature: Count validation

 Scenario: To validate whether the record count is matching between source and Target  
   Given the source document "contact_info.csv" have records
   When the data in target document "contact_info.csv" is loaded
   Then the count between source document and target document should match             
